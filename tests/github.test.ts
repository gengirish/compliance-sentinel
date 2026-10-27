import { execFileSync } from "node:child_process";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveFromRoot } from "../src/config.js";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { auditRuns, repos, tenants } from "../src/db/schema.js";
import { appJwt, GitHubApp, verifyGitHubSignature } from "../src/github/app.js";
import { OfflineAnalyst } from "../src/llm/offlineAnalyst.js";
import { cloneRepo, runPipeline } from "../src/pipeline/run.js";
import { INSTALL_JOB, type AuditJobData } from "../src/queue/queue.js";
import { LocalHashEmbedder } from "../src/rag/embed.js";
import { createApp, GITHUB_WEBHOOK_PATH } from "../src/web/server.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake GitHub API: installation tokens and repository metadata, recording each call. */
function fakeGitHub(defaultBranch = "main") {
  const calls: { method: string; url: string; auth: string }[] = [];
  let minted = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get("authorization") ?? "";
    calls.push({ method: init.method ?? "GET", url, auth });
    const tokenPath = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (tokenPath) return json({ token: `ghs_token${++minted}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    const repoPath = /\/repos\/([^/]+\/[^/]+)$/.exec(url);
    if (repoPath) return json({ id: 9001, full_name: repoPath[1], default_branch: defaultBranch });
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("GitHub App auth", () => {
  it("signs a JWT GitHub can verify, backdated for clock drift", () => {
    const now = Date.UTC(2026, 9, 27, 12);
    const [header, payload, signature] = appJwt("5492169", privateKey, now).split(".");
    const ok = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, "base64url"));
    expect(ok).toBe(true);
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims).toEqual({ iss: "5492169", iat: now / 1000 - 60, exp: now / 1000 + 540 });
  });

  it("verifies webhook signatures", () => {
    const body = '{"zen":"Keep it logically awesome."}';
    const good = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(verifyGitHubSignature(body, good, "s3cret")).toBe(true);
    expect(verifyGitHubSignature(body, good, "other")).toBe(false);
    expect(verifyGitHubSignature(`${body} `, good, "s3cret")).toBe(false);
    expect(verifyGitHubSignature(body, undefined, "s3cret")).toBe(false);
    expect(verifyGitHubSignature(body, "sha256=zz", "s3cret")).toBe(false);
  });

  it("mints an installation token with the App JWT and reuses it until near expiry", async () => {
    const gh = fakeGitHub();
    let now = Date.now();
    const app = new GitHubApp({ appId: "1", privateKey, apiUrl: "https://api.test", fetchImpl: gh.fetchImpl, now: () => now });

    expect(await app.installationToken(42)).toBe("ghs_token1");
    expect(await app.installationToken(42)).toBe("ghs_token1");
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]).toMatchObject({ method: "POST", url: "https://api.test/app/installations/42/access_tokens" });
    expect(gh.calls[0]!.auth).toMatch(/^Bearer ey/);

    await app.getRepo(42, "acme/app");
    expect(gh.calls[1]).toMatchObject({ url: "https://api.test/repos/acme/app", auth: "Bearer ghs_token1" });

    now += 56 * 60 * 1000; // inside the 5-minute margin before the hour is up
    expect(await app.installationToken(42)).toBe("ghs_token2");
  });
});

describe("GitHub webhook", () => {
  const SECRET = "webhook-secret";
  let handle: DbHandle;
  let app: ReturnType<typeof createApp>;
  const added: { name: string; data: AuditJobData; jobId?: string }[] = [];
  const queue = {
    add: async (name: string, data: AuditJobData, opts?: { jobId?: string }) => (added.push({ name, data, jobId: opts?.jobId }), { id: opts?.jobId }),
  } as unknown as Queue<AuditJobData>;

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    app = createApp({ db: handle.db, getQueue: () => queue, token: "t", githubWebhookSecret: SECRET });
  });
  afterAll(() => handle.close());

  const deliver = (event: string, delivery: string, payload: unknown, secret = SECRET) => {
    const body = JSON.stringify(payload);
    return app.request(GITHUB_WEBHOOK_PATH, {
      method: "POST",
      body,
      headers: {
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    });
  };
  const installation = { id: 77, account: { login: "acme" } };
  const reposOf = async (installationId: number) => {
    const [tenant] = await handle.db.select().from(tenants).where(eq(tenants.githubInstallationId, installationId));
    const rows = await handle.db.select().from(repos).where(eq(repos.tenantId, tenant!.id)).orderBy(repos.githubRepoId);
    return { tenant: tenant!, rows };
  };

  it("needs a configured secret and a valid signature, but not the trigger token", async () => {
    const closed = createApp({ db: handle.db, getQueue: () => queue, token: "t" });
    expect((await closed.request(GITHUB_WEBHOOK_PATH, { method: "POST", body: "{}" })).status).toBe(503);
    expect((await deliver("ping", "d-0", { zen: "hi" }, "wrong")).status).toBe(401);
    expect((await deliver("ping", "d-0", { zen: "hi" })).status).toBe(202);
  });

  it("creates a tenant and its repos on install, and queues one baseline audit per repo", async () => {
    const res = await deliver("installation", "d-1", {
      action: "created",
      installation,
      repositories: [
        { id: 101, full_name: "acme/api" },
        { id: 102, full_name: "acme/web" },
      ],
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: 2 });

    const { tenant, rows } = await reposOf(77);
    expect(tenant.name).toBe("acme");
    expect(rows.map((r) => [r.githubRepoId, r.fullName, r.active])).toEqual([
      [101, "acme/api", true],
      [102, "acme/web", true],
    ]);
    expect(added.map((a) => [a.name, a.jobId])).toEqual(rows.map((r) => [INSTALL_JOB, `gh-d-1-${r.id}`]));
    expect(added[0]!.data).toEqual({ trigger: "install", tenantId: tenant.id, repoId: rows[0]!.id, demo: true, rulePacks: ["pci"] });
  });

  it("gives a redelivery the same job ids, so the queue ignores it", async () => {
    const before = added.map((a) => a.jobId);
    await deliver("installation", "d-1", { action: "created", installation, repositories: [{ id: 101, full_name: "acme/api" }, { id: 102, full_name: "acme/web" }] });
    expect(added.slice(before.length).map((a) => a.jobId)).toEqual(before);
    expect((await reposOf(77)).rows).toHaveLength(2);
  });

  it("follows repositories added to and removed from the installation", async () => {
    added.length = 0;
    await deliver("installation_repositories", "d-2", {
      action: "added",
      installation,
      repositories_added: [{ id: 103, full_name: "acme/jobs" }],
      repositories_removed: [{ id: 101, full_name: "acme/api" }],
    });
    const { rows } = await reposOf(77);
    expect(rows.map((r) => [r.fullName, r.active])).toEqual([
      ["acme/api", false],
      ["acme/web", true],
      ["acme/jobs", true],
    ]);
    expect(added.map((a) => a.data.repoId)).toEqual([rows[2]!.id]);
  });

  it("keeps the data but deactivates every repo when the App is uninstalled", async () => {
    added.length = 0;
    expect((await deliver("installation", "d-3", { action: "deleted", installation })).status).toBe(202);
    expect((await reposOf(77)).rows.every((r) => !r.active)).toBe(true);
    expect(added).toHaveLength(0);
  });

  it("acknowledges pull requests without acting yet, and rejects malformed payloads", async () => {
    expect(await (await deliver("pull_request", "d-4", { action: "opened" })).json()).toEqual({ queued: 0 });
    expect((await deliver("installation", "d-5", { action: "created" })).status).toBe(400);
  });
});

describe("auditing a repository through the App", () => {
  let handle: DbHandle;
  let base: string;
  let work: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" })
      .toString()
      .trim();

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    // A bare repository at <base>/acme/shop.git stands in for github.com.
    base = mkdtempSync(path.join(tmpdir(), "sentinel-gh-"));
    work = path.join(base, "work");
    mkdirSync(work);
    git(work, "init", "--quiet");
    writeFileSync(path.join(work, "payments.js"), "export function charge(card) {\n  console.log('charging', card.number);\n}\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "init");
    mkdirSync(path.join(base, "acme"));
    git(base, "clone", "--quiet", "--bare", work, path.join(base, "acme", "shop.git"));
  });
  afterAll(async () => {
    await handle.close();
    rmSync(base, { recursive: true, force: true });
  });

  it("clones with a token that never reaches .git/config", async () => {
    const dir = path.join(base, "clone");
    await cloneRepo(pathToFileURL(path.join(base, "acme", "shop.git")).href, "main", { token: "ghs_SECRET", dir });
    expect(readFileSync(path.join(dir, "payments.js"), "utf8")).toContain("charge");
    expect(readFileSync(path.join(dir, ".git", "config"), "utf8")).not.toContain("ghs_SECRET");
    expect(readFileSync(path.join(dir, ".git", "config"), "utf8")).not.toContain("extraheader");
  });

  it("keeps the token out of a failed clone's error, which ends up in audit_runs.error", async () => {
    const missing = pathToFileURL(path.join(base, "acme", "gone.git")).href;
    const err = await cloneRepo(missing, "main", { token: "ghs_SECRET", dir: path.join(base, "gone") }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const basic = Buffer.from("x-access-token:ghs_SECRET").toString("base64");
    expect((err as Error).message).not.toContain("ghs_SECRET");
    expect((err as Error).message).not.toContain(basic);
  });

  it("clones the default branch, records the run's repo and commit, sets the baseline, and removes the clone", async () => {
    const [tenant] = await handle.db.insert(tenants).values({ name: "acme", githubInstallationId: 77 }).returning();
    const [repo] = await handle.db.insert(repos).values({ tenantId: tenant!.id, githubRepoId: 9001, fullName: "acme/shop" }).returning();
    const gh = fakeGitHub("main");
    const github = new GitHubApp({ appId: "1", privateKey, apiUrl: "https://api.test", gitUrl: pathToFileURL(base).href, fetchImpl: gh.fetchImpl });

    const result = await runPipeline({
      trigger: "install",
      tenantId: tenant!.id,
      repoId: repo!.id,
      demo: true,
      rulePacks: ["pci"],
      github,
      handle,
      analyst: new OfflineAnalyst(),
      embedder: new LocalHashEmbedder(),
      deps: { renderReport: async (s) => ({ url: `memory://${s.runId}`, path: `memory://${s.runId}` }), notify: async () => [] },
    });

    expect(result.status).toBe("completed");
    const head = git(work, "rev-parse", "HEAD");
    const [run] = await handle.db.select().from(auditRuns).where(eq(auditRuns.id, result.runId));
    expect(run).toMatchObject({ tenantId: tenant!.id, repoId: repo!.id, headSha: head, trigger: "install" });
    const [after] = await handle.db.select().from(repos).where(eq(repos.id, repo!.id));
    expect(after).toMatchObject({ defaultBranch: "main", baselineRunId: result.runId, baselineSha: head });
    expect(existsSync(resolveFromRoot(`.data/repos/${repo!.id}-main`))).toBe(false);
  });

  it("refuses a repository of another tenant, or one no longer installed", async () => {
    const [other] = await handle.db.insert(tenants).values({ name: "other", githubInstallationId: 88 }).returning();
    const [repo] = await handle.db.select().from(repos).where(eq(repos.fullName, "acme/shop"));
    const common = { trigger: "manual" as const, demo: true, rulePacks: ["pci"], github: null, handle, analyst: new OfflineAnalyst(), embedder: new LocalHashEmbedder() };
    await expect(runPipeline({ ...common, tenantId: other!.id, repoId: repo!.id })).rejects.toThrow(/does not belong/);
    await handle.db.update(repos).set({ active: false }).where(eq(repos.id, repo!.id));
    await expect(runPipeline({ ...common, tenantId: repo!.tenantId, repoId: repo!.id })).rejects.toThrow(/no longer installed/);
  });
});
