import { config } from "../config.js";
import { openMigratedDb, type DbHandle } from "../db/client.js";
import { Budget, type Analyst } from "../llm/analyst.js";
import { errorMessage, log } from "../log.js";
import { createAnalyst } from "../pipeline/run.js";
import { deliverDigest, type DigestReport } from "./deliver.js";
import { digestRule, rulesChangedSince, type RuleDigestRecord } from "./digestRule.js";

export type WeeklyDigestOptions = {
  /** Look-back window in days; default DIGEST_DAYS. */
  days?: number;
  /** Send the digest to the configured channels (otherwise only build it). */
  send?: boolean;
  /** Injected in tests. */
  handle?: DbHandle;
  analyst?: Analyst;
  now?: Date;
  deliver?: typeof deliverDigest;
};

export type WeeklyDigestResult = DigestReport & { notified: string[]; errors: string[] };

/**
 * The weekly "what changed" round-up: every rule whose text changed in the
 * window, digested (reusing stored digests), delivered by email and Slack.
 * It needs no scrape, no embedding and no code: the daily audit already put
 * the rules in the store, whether or not it found them worth auditing.
 */
export async function runWeeklyDigest(opts: WeeklyDigestOptions = {}): Promise<WeeklyDigestResult> {
  const handle = opts.handle ?? (await openMigratedDb());
  const ownsHandle = !opts.handle;
  const analyst = opts.analyst ?? createAnalyst();
  const now = opts.now ?? new Date();
  const days = opts.days ?? config.DIGEST_DAYS;
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const budget = new Budget(config.MAX_RUN_COST_USD);

  try {
    const changed = await rulesChangedSince(handle.db, since);
    const records: RuleDigestRecord[] = [];
    const errors: string[] = [];
    for (const rule of changed) {
      if (budget.exceeded) {
        errors.push(`rule ${rule.id}: digest skipped, budget of $${budget.maxUsd} reached`);
        continue;
      }
      try {
        const record = await digestRule(handle.db, analyst, rule);
        budget.add(record.costUsd);
        records.push(record);
      } catch (err) {
        errors.push(`rule ${rule.id}: digest failed: ${errorMessage(err)}`);
      }
    }
    const report: DigestReport = {
      from: since.toISOString().slice(0, 10),
      to: now.toISOString().slice(0, 10),
      records,
      costUsd: budget.spent,
    };
    const notified = opts.send ? await (opts.deliver ?? deliverDigest)(report) : [];
    log.info("weekly digest built", { rules: changed.length, digested: records.length, costUsd: budget.spent, notified, errors: errors.length });
    return { ...report, notified, errors };
  } finally {
    if (ownsHandle) await handle.close();
  }
}
