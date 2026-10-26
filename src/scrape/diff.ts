import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { rules, sources, type Rule } from "../db/schema.js";

export type SourceDef = {
  name: string;
  kind: "api" | "playwright" | "fixture";
  url: string;
};

/** A rule as fetched from a portal, before it is compared with what we stored. */
export type ScrapedRule = {
  externalId: string;
  title: string;
  effectiveDate: string | null;
  url: string;
  rawText: string;
};

export type RuleChange = { kind: "new" | "amended"; rule: ScrapedRule; contentHash: string };

/** Collapses whitespace so cosmetic re-renders of a page do not count as amendments. */
export function normalizeRuleText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function contentHash(text: string): string {
  return createHash("sha256").update(normalizeRuleText(text)).digest("hex");
}

/**
 * Pure change detection: returns only rules that are new or whose normalized
 * content changed. `known` maps external_id -> stored content hash.
 */
export function diffRules(scraped: ScrapedRule[], known: Map<string, string>): RuleChange[] {
  const changes: RuleChange[] = [];
  const seen = new Set<string>();
  for (const rule of scraped) {
    if (seen.has(rule.externalId)) continue;
    seen.add(rule.externalId);
    const hash = contentHash(rule.rawText);
    const previous = known.get(rule.externalId);
    if (previous === undefined) changes.push({ kind: "new", rule, contentHash: hash });
    else if (previous !== hash) changes.push({ kind: "amended", rule, contentHash: hash });
  }
  return changes;
}

export async function upsertSource(db: Db, def: SourceDef): Promise<number> {
  const [row] = await db
    .insert(sources)
    .values(def)
    .onConflictDoUpdate({ target: sources.name, set: { kind: def.kind, url: def.url } })
    .returning({ id: sources.id });
  return row!.id;
}

/**
 * Compares scraped rules with stored ones, persists the new/amended rows and
 * returns them. `force` re-emits unchanged rules too (demo runs).
 */
export async function persistChanges(
  db: Db,
  sourceId: number,
  scraped: ScrapedRule[],
  opts: { force?: boolean } = {},
): Promise<{ changed: Rule[]; changes: RuleChange[] }> {
  const ids = scraped.map((r) => r.externalId);
  const existing = ids.length
    ? await db
        .select({ externalId: rules.externalId, contentHash: rules.contentHash })
        .from(rules)
        .where(and(eq(rules.sourceId, sourceId), inArray(rules.externalId, ids)))
    : [];
  const known = new Map(existing.map((r) => [r.externalId, r.contentHash]));
  const changes = diffRules(scraped, opts.force ? new Map() : known);

  const changed: Rule[] = [];
  for (const change of changes) {
    const values = {
      sourceId,
      externalId: change.rule.externalId,
      title: change.rule.title,
      effectiveDate: change.rule.effectiveDate,
      url: change.rule.url,
      contentHash: change.contentHash,
      rawText: normalizeRuleText(change.rule.rawText),
    };
    const [row] = await db
      .insert(rules)
      .values(values)
      .onConflictDoUpdate({
        target: [rules.sourceId, rules.externalId],
        set: {
          title: values.title,
          effectiveDate: values.effectiveDate,
          url: values.url,
          contentHash: values.contentHash,
          // The stored row's text (not EXCLUDED's) becomes the previous version.
          previousRawText: sql`${rules.rawText}`,
          rawText: values.rawText,
          lastChangedAt: sql`now()`,
        },
      })
      .returning();
    changed.push(row!);
  }
  await db.update(sources).set({ lastCheckedAt: sql`now()` }).where(eq(sources.id, sourceId));
  return { changed, changes };
}
