import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { ruleDigests, rules, sources, type Rule, type RuleDigestRow } from "../db/schema.js";
import type { RuleDigest } from "../graph/types.js";
import type { Analyst } from "../llm/analyst.js";
import { log } from "../log.js";

/** One digested rule version, with what a reader needs to place it. */
export type RuleDigestRecord = {
  ruleId: number;
  source: string;
  title: string;
  url: string;
  effectiveDate: string | null;
  kind: "new" | "amended";
  /** ISO timestamp of when the rule text last changed. */
  changedAt: string;
  digest: RuleDigest;
  /** True when a digest for this exact text already existed and no model call was made. */
  reused: boolean;
  costUsd: number;
};

export type RuleWithSource = Rule & { sourceName: string };

export async function findDigest(db: Db, ruleId: number, contentHash: string): Promise<RuleDigestRow | undefined> {
  const [row] = await db
    .select()
    .from(ruleDigests)
    .where(and(eq(ruleDigests.ruleId, ruleId), eq(ruleDigests.contentHash, contentHash)))
    .limit(1);
  return row;
}

/** Rules whose text changed at or after `since`, newest change first, with their source name. */
export async function rulesChangedSince(db: Db, since: Date): Promise<RuleWithSource[]> {
  const rows = await db
    .select({ rule: rules, sourceName: sources.name })
    .from(rules)
    .innerJoin(sources, eq(sources.id, rules.sourceId))
    .where(gte(rules.lastChangedAt, since))
    .orderBy(desc(rules.lastChangedAt), desc(rules.id));
  return rows.map((r) => ({ ...r.rule, sourceName: r.sourceName }));
}

async function sourceName(db: Db, sourceId: number): Promise<string> {
  const [row] = await db.select({ name: sources.name }).from(sources).where(eq(sources.id, sourceId)).limit(1);
  return row?.name ?? `source ${sourceId}`;
}

/**
 * The digest of a rule's current text: stored once per (rule, content hash),
 * so re-running a digest or sending a weekly round-up never pays twice for
 * the same version.
 */
export async function digestRule(db: Db, analyst: Analyst, rule: Rule | RuleWithSource): Promise<RuleDigestRecord> {
  const kind: "new" | "amended" = rule.previousRawText ? "amended" : "new";
  const base = {
    ruleId: rule.id,
    source: "sourceName" in rule ? rule.sourceName : await sourceName(db, rule.sourceId),
    title: rule.title,
    url: rule.url,
    effectiveDate: rule.effectiveDate,
    kind,
    changedAt: rule.lastChangedAt.toISOString(),
  };

  const existing = await findDigest(db, rule.id, rule.contentHash);
  if (existing) return { ...base, digest: existing.digest, reused: true, costUsd: 0 };

  const { digest, costUsd } = await analyst.digest({ rule, kind, previousText: rule.previousRawText ?? null });
  await db
    .insert(ruleDigests)
    .values({ ruleId: rule.id, contentHash: rule.contentHash, kind, digest, analyst: analyst.name, costUsd })
    .onConflictDoNothing();
  log.info("rule digested", { ruleId: rule.id, kind, analyst: analyst.name, costUsd });
  return { ...base, digest, reused: false, costUsd };
}
