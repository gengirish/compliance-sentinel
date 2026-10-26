import { and, eq, inArray, lt, notLike, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditRuns, rules } from "../db/schema.js";
import { log } from "../log.js";

export type StaleRunSweep = {
  maxAgeMinutes: number;
  /** Restrict the sweep to these runs (the one-off CLI); otherwise every stale run. */
  runIds?: number[];
  /** Report what would change without writing. */
  dryRun?: boolean;
};

/**
 * Marks runs that have been "running" for longer than `maxAgeMinutes` as failed.
 * A run only leaves "running" from inside runPipeline, so a worker that crashes,
 * is redeployed or loses its job lock mid-run leaves the row behind for good.
 * As in runPipeline's own failure path, the rules the run was auditing are marked
 * unaudited so the next run picks them up instead of skipping them.
 */
export async function failStaleRuns(db: Db, opts: StaleRunSweep): Promise<number[]> {
  const where = and(
    eq(auditRuns.status, "running"),
    lt(auditRuns.startedAt, sql`now() - make_interval(mins => ${opts.maxAgeMinutes})`),
    opts.runIds?.length ? inArray(auditRuns.id, opts.runIds) : undefined,
  );
  if (opts.dryRun) {
    const rows = await db.select({ id: auditRuns.id }).from(auditRuns).where(where);
    return rows.map((r) => r.id);
  }

  const reason =
    `Timed out: still running after ${opts.maxAgeMinutes} minutes. ` +
    "The worker most likely restarted or crashed mid-run; the rules in scope will be audited again on the next run.";
  const failed = await db
    .update(auditRuns)
    .set({ status: "failed", finishedAt: sql`now()`, error: reason })
    .where(where)
    .returning({ id: auditRuns.id, rulesInScope: auditRuns.rulesInScope });
  if (failed.length === 0) return [];

  const scope = [...new Set(failed.flatMap((r) => r.rulesInScope))];
  if (scope.length > 0) {
    await db
      .update(rules)
      .set({ contentHash: sql`'unaudited:' || ${rules.contentHash}` })
      .where(and(inArray(rules.id, scope), notLike(rules.contentHash, "unaudited:%")));
  }
  const ids = failed.map((r) => r.id);
  log.warn("stale runs marked failed", { runIds: ids, maxAgeMinutes: opts.maxAgeMinutes });
  return ids;
}
