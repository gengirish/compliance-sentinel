import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, openDb, openMigratedDb, type DbHandle } from "../src/db/client.js";
import { codeChunks, LOCAL_TENANT_ID, repos, tenants } from "../src/db/schema.js";
import { ensureRepo, resolveTenantId } from "../src/db/tenants.js";
import { LocalHashEmbedder } from "../src/rag/embed.js";
import { indexRepo } from "../src/rag/indexRepo.js";

describe("tenancy", () => {
  let handle: DbHandle;
  let dir: string;
  const embedder = new LocalHashEmbedder();

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    dir = mkdtempSync(path.join(tmpdir(), "sentinel-tenancy-"));
  });
  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const snapshot = async (body: string, tenantId?: number) => {
    writeFileSync(path.join(dir, "app.js"), body);
    return indexRepo(handle.db, embedder, dir, { repoName: "acme/app", tenantId });
  };
  const indexedShas = async (repoId: number) =>
    new Set((await handle.db.select({ sha: codeChunks.commitSha }).from(codeChunks).where(eq(codeChunks.repoId, repoId))).map((r) => r.sha));

  it("seeds the local tenant, and resolves a header only to a linked tenant", async () => {
    const [local] = await handle.db.select().from(tenants).where(eq(tenants.id, LOCAL_TENANT_ID));
    expect(local?.name).toBe("local");
    await handle.db.insert(tenants).values({ name: "Acme", clerkOrgId: "org_acme" });

    expect(await resolveTenantId(handle.db, undefined)).toBe(LOCAL_TENANT_ID);
    expect(await resolveTenantId(handle.db, "org_acme")).not.toBe(LOCAL_TENANT_ID);
    expect(await resolveTenantId(handle.db, "org_unknown")).toBeNull();
  });

  it("creates one repo row per tenant and name", async () => {
    const a = await ensureRepo(handle.db, LOCAL_TENANT_ID, "acme/same");
    const again = await ensureRepo(handle.db, LOCAL_TENANT_ID, "acme/same");
    const acme = (await resolveTenantId(handle.db, "org_acme"))!;
    const other = await ensureRepo(handle.db, acme, "acme/same");
    expect(again.id).toBe(a.id);
    expect(other.id).not.toBe(a.id);
  });

  it("keeps the baseline snapshot when a newer one is indexed", async () => {
    const base = await snapshot("console.log('v1');\n");
    await handle.db.update(repos).set({ baselineSha: base.commitSha }).where(eq(repos.id, base.repoId));

    const pr1 = await snapshot("console.log('v2');\n");
    expect(await indexedShas(base.repoId)).toEqual(new Set([base.commitSha, pr1.commitSha]));

    // A later snapshot replaces the earlier non-baseline one, never the baseline.
    const pr2 = await snapshot("console.log('v3');\n");
    expect(await indexedShas(base.repoId)).toEqual(new Set([base.commitSha, pr2.commitSha]));
  });

  it("indexes the same repository name separately for each tenant", async () => {
    const acme = (await resolveTenantId(handle.db, "org_acme"))!;
    const local = await snapshot("console.log('local');\n");
    const theirs = await snapshot("console.log('local');\n", acme);
    expect(theirs.repoId).not.toBe(local.repoId);
    expect(theirs.reindexed).toBe(true);
  });

  it("migrates a pre-tenancy database into the local tenant", async () => {
    const old = await openDb({ pgliteDir: "memory" });
    try {
      // Bring a fresh database to the state before 0004, the way migrate() would have.
      const dir = path.join(import.meta.dirname, "..", "src", "db", "migrations");
      await old.db.execute(sql`CREATE TABLE _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const file of readdirSync(dir).filter((f) => f < "0004").sort()) {
        for (const statement of readFileSync(path.join(dir, file), "utf8").split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) {
          await old.db.execute(sql.raw(statement));
        }
        await old.db.execute(sql`INSERT INTO _migrations (name) VALUES (${file})`);
      }
      const vector = `[${Array(1024).fill(0).join(",")}]`;
      await old.db.execute(sql`INSERT INTO audit_runs (status, trigger) VALUES ('completed', 'manual')`);
      await old.db.execute(
        sql`INSERT INTO code_chunks (repo, commit_sha, path, start_line, end_line, text, embedding)
            VALUES ('demo-target-app', 'abc', 'a.js', 1, 1, 'x', ${vector}::vector), ('acme/app', 'def', 'b.js', 1, 1, 'y', ${vector}::vector)`,
      );

      expect(await migrate(old.db)).toContain("0004_tenants.sql");

      const repoRows = await old.db.select().from(repos);
      expect(repoRows.map((r) => [r.tenantId, r.fullName]).sort()).toEqual([
        [LOCAL_TENANT_ID, "acme/app"],
        [LOCAL_TENANT_ID, "demo-target-app"],
      ]);
      const chunks = await old.db.select({ repoId: codeChunks.repoId, path: codeChunks.path }).from(codeChunks);
      const byName = new Map(repoRows.map((r) => [r.fullName, r.id]));
      expect(chunks.find((c) => c.path === "a.js")?.repoId).toBe(byName.get("demo-target-app"));
      expect(chunks.find((c) => c.path === "b.js")?.repoId).toBe(byName.get("acme/app"));
      const runs = (await old.db.execute(sql`SELECT tenant_id FROM audit_runs`)) as unknown as { rows: { tenant_id: number }[] };
      expect(runs.rows.map((r) => Number(r.tenant_id))).toEqual([LOCAL_TENANT_ID]);
    } finally {
      await old.close();
    }
  });
});
