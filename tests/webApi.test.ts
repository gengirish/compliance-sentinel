/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed JSON responses */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { OfflineAnalyst } from "../src/llm/offlineAnalyst.js";
import { runPipeline } from "../src/pipeline/run.js";
import { LocalHashEmbedder } from "../src/rag/embed.js";
import { tenants } from "../src/db/schema.js";
import { TENANT_HEADER } from "../src/db/tenants.js";
import { createApp } from "../src/web/server.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

/** The dashboard's read endpoints, against a real demo audit in an in-memory database. */
describe("web API", () => {
  let handle: DbHandle;
  let app: ReturnType<typeof createApp>;
  let runId: number;

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    const result = await runPipeline({
      trigger: "manual",
      demo: true,
      handle,
      analyst: new OfflineAnalyst(),
      embedder: new LocalHashEmbedder(),
      deps: {
        renderReport: async (state) => ({ url: `memory://run-${state.runId}`, path: `memory://run-${state.runId}` }),
        notify: async () => ["test"],
      },
    });
    runId = result.state!.runId;
    app = createApp({
      db: handle.db,
      getQueue: () => {
        throw new Error("queue not available in tests");
      },
      token: TOKEN,
    });
  });
  afterAll(() => handle.close());

  const get = async (path: string, tenant?: string) => {
    const res = await app.request(path, { headers: tenant ? { ...auth, [TENANT_HEADER]: tenant } : auth });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("rejects requests without the token", async () => {
    const res = await app.request("/stats");
    expect(res.status).toBe(401);
  });

  it("summarises the latest completed run", async () => {
    const { status, body } = await get("/stats");
    expect(status).toBe(200);
    expect(body.latestCompletedRun.id).toBe(runId);
    expect(body.latestCompletedRun.counts.byStatus.violation).toBeGreaterThanOrEqual(5);
    expect(body.totals.rules).toBeGreaterThan(0);
  });

  it("returns one run with counts, and 404 for an unknown run", async () => {
    const { body } = await get(`/runs/${runId}`);
    expect(body.counts.total).toBe(
      body.counts.byStatus.compliant + body.counts.byStatus.violation + body.counts.byStatus.needs_review,
    );
    expect((await get("/runs/9999")).status).toBe(404);
    expect((await get("/runs/abc")).status).toBe(400);
  });

  it("lists findings with rule and resolved citations, and filters them", async () => {
    const all = await get(`/runs/${runId}/findings`);
    expect(all.body.length).toBeGreaterThan(0);
    const violation = all.body.find((f: any) => f.status === "violation");
    expect(violation.rule.title).toBeTruthy();
    expect(violation.citations.length).toBeGreaterThan(0);
    expect(violation.evidence[0].path).toBeTruthy();

    const filtered = await get(`/runs/${runId}/findings?status=violation&severity=critical`);
    expect(filtered.body.length).toBeGreaterThan(0);
    expect(filtered.body.every((f: any) => f.status === "violation" && f.severity === "critical")).toBe(true);
  });

  it("rejects malformed input with a 400 that names the bad field", async () => {
    const bogus = await get(`/runs/${runId}/findings?severity=critical,bogus`);
    expect(bogus.status).toBe(400);
    expect(bogus.body.issues.some((i: any) => i.path.startsWith("severity"))).toBe(true);

    const badId = await get("/runs/1.5");
    expect(badId.status).toBe(400);
    expect(badId.body.issues[0].path).toBe("id");

    expect((await get("/runs?counts=yes")).status).toBe(400);
    const badDemo = await app.request("/runs?demo=maybe", { method: "POST", headers: auth });
    expect(badDemo.status).toBe(400);
  });

  it("lists runs with counts only when asked", async () => {
    const plain = await get("/runs");
    expect(plain.body[0].counts).toBeUndefined();
    const withCounts = await get("/runs?counts=1");
    expect(withCounts.body[0].counts.total).toBeGreaterThanOrEqual(0);
  });

  it("lists rules with the last run that audited them", async () => {
    const { body } = await get("/rules");
    expect(body.length).toBeGreaterThan(0);
    expect(body.some((r: any) => r.lastAuditedRunId === runId)).toBe(true);
    expect(body[0].source.name).toBeTruthy();
  });

  describe("tenant isolation", () => {
    let otherRunId: number;

    beforeAll(async () => {
      const [other] = await handle.db
        .insert(tenants)
        .values({ name: "Other Co", clerkOrgId: "org_other" })
        .returning({ id: tenants.id });
      const result = await runPipeline({
        trigger: "manual",
        tenantId: other!.id,
        demo: true,
        handle,
        analyst: new OfflineAnalyst(),
        embedder: new LocalHashEmbedder(),
        deps: {
          renderReport: async (state) => ({ url: `memory://run-${state.runId}`, path: `memory://run-${state.runId}` }),
          notify: async () => ["test"],
        },
      });
      otherRunId = result.runId;
    });

    it("lists only the caller's runs", async () => {
      const mine = await get("/runs");
      const theirs = await get("/runs", "org_other");
      expect(mine.body.map((r: any) => r.id)).toContain(runId);
      expect(mine.body.map((r: any) => r.id)).not.toContain(otherRunId);
      expect(theirs.body.map((r: any) => r.id)).toEqual([otherRunId]);
    });

    it("answers 404 for another tenant's run, findings and report", async () => {
      for (const path of [`/runs/${otherRunId}`, `/runs/${otherRunId}/findings`, `/reports/${otherRunId}`]) {
        expect((await get(path)).status, path).toBe(404);
      }
      for (const path of [`/runs/${runId}`, `/runs/${runId}/findings`, `/reports/${runId}`]) {
        expect((await get(path, "org_other")).status, path).toBe(404);
      }
    });

    it("never resolves another tenant's report", async () => {
      // Both runs have in-memory report paths, so the owner gets "file gone"; anyone else must not get that far.
      expect((await get(`/reports/${runId}`)).body.error).toBe("report file is gone");
      expect((await get(`/reports/${runId}`, "org_other")).body.error).toBe("no report for this run");
      expect((await get(`/reports/${otherRunId}`)).body.error).toBe("no report for this run");
    });

    it("scopes stats and the last audit of each rule", async () => {
      const stats = await get("/stats", "org_other");
      expect(stats.body.latestRun.id).toBe(otherRunId);
      expect(stats.body.totals.runs).toBe(1);

      const rules = await get("/rules", "org_other");
      const audited = rules.body.map((r: any) => r.lastAuditedRunId).filter(Boolean);
      expect(audited.length).toBeGreaterThan(0);
      expect(audited.every((id: number) => id === otherRunId)).toBe(true);
    });

    it("shows an unknown tenant nothing and lets it trigger nothing", async () => {
      expect((await get("/runs", "org_nobody")).body).toEqual([]);
      const stats = await get("/stats", "org_nobody");
      expect(stats.body.latestRun).toBeNull();
      expect(stats.body.totals.runs).toBe(0);
      expect((await get("/rules", "org_nobody")).body.every((r: any) => r.lastAuditedRunId === null)).toBe(true);
      expect((await get(`/runs/${runId}`, "org_nobody")).status).toBe(404);
      const trigger = await app.request("/runs", { method: "POST", headers: { ...auth, [TENANT_HEADER]: "org_nobody" } });
      expect(trigger.status).toBe(409);
    });
  });
});
