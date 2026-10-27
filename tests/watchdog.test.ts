/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed JSON responses */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { auditRuns, LOCAL_TENANT_ID, rules, sources } from "../src/db/schema.js";
import { failStaleRuns } from "../src/pipeline/watchdog.js";
import { createApp } from "../src/web/server.js";

const TIMEOUT = 30;

/** Runs left "running" by a crashed worker must not stay that way. */
describe("stale run watchdog", () => {
  let handle: DbHandle;
  let ruleId: number;

  const insertRun = async (minutesAgo: number, rulesInScope: number[] = []) => {
    const [row] = await handle.db
      .insert(auditRuns)
      .values({
        tenantId: LOCAL_TENANT_ID,
        status: "running",
        trigger: "manual",
        rulesInScope,
        startedAt: sql`now() - make_interval(mins => ${minutesAgo})`,
      })
      .returning({ id: auditRuns.id });
    return row!.id;
  };
  const runById = async (id: number) => (await handle.db.select().from(auditRuns).where(eq(auditRuns.id, id)))[0]!;

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    const [source] = await handle.db
      .insert(sources)
      .values({ name: "test", kind: "fixture", url: "https://example.com" })
      .returning({ id: sources.id });
    const [rule] = await handle.db
      .insert(rules)
      .values({ sourceId: source!.id, externalId: "R-1", title: "Rule", url: "https://example.com/r", contentHash: "abc", rawText: "text" })
      .returning({ id: rules.id });
    ruleId = rule!.id;
  });
  afterAll(() => handle.close());

  it("fails runs older than the timeout with a reason, and leaves recent ones alone", async () => {
    const stale = await insertRun(41 * 60, [ruleId]);
    const fresh = await insertRun(2);

    expect(await failStaleRuns(handle.db, { maxAgeMinutes: TIMEOUT, dryRun: true })).toEqual([stale]);
    expect((await runById(stale)).status).toBe("running");

    expect(await failStaleRuns(handle.db, { maxAgeMinutes: TIMEOUT })).toEqual([stale]);
    const failed = await runById(stale);
    expect(failed.status).toBe("failed");
    expect(failed.finishedAt).not.toBeNull();
    expect(failed.error).toMatch(/Timed out: still running after 30 minutes/);
    expect((await runById(fresh)).status).toBe("running");

    // Its rules are re-queued for audit, exactly once.
    const [rule] = await handle.db.select().from(rules).where(eq(rules.id, ruleId));
    expect(rule!.contentHash).toBe("unaudited:abc");
    expect(await failStaleRuns(handle.db, { maxAgeMinutes: TIMEOUT })).toEqual([]);
  });

  it("can target one run, as the repair CLI does", async () => {
    const a = await insertRun(120);
    const b = await insertRun(120);
    expect(await failStaleRuns(handle.db, { maxAgeMinutes: TIMEOUT, runIds: [b] })).toEqual([b]);
    expect((await runById(a)).status).toBe("running");
  });

  it("never lists a run older than the timeout as running through the API", async () => {
    await insertRun(90);
    const app = createApp({
      db: handle.db,
      getQueue: () => {
        throw new Error("queue not available in tests");
      },
      token: "t",
      runTimeoutMinutes: TIMEOUT,
    });
    const res = await app.request("/runs", { headers: { authorization: "Bearer t" } });
    const runs = (await res.json()) as any[];
    const cutoff = Date.now() - TIMEOUT * 60_000;
    const stuck = runs.filter((r) => r.status === "running" && Date.parse(r.startedAt) < cutoff);
    expect(stuck).toEqual([]);
  });
});
