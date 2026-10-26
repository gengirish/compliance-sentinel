import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

export const EMBEDDING_DIMENSIONS = 1024;

export type CodeEvidence = {
  path: string;
  start_line: number;
  end_line: number;
  excerpt: string;
};

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const sources = pgTable("sources", {
  id: id(),
  name: text("name").notNull().unique(),
  kind: text("kind", { enum: ["api", "playwright", "fixture"] }).notNull(),
  url: text("url").notNull(),
  lastCheckedAt: ts("last_checked_at"),
});

export const rules = pgTable(
  "rules",
  {
    id: id(),
    sourceId: bigint("source_id", { mode: "number" })
      .notNull()
      .references(() => sources.id),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    effectiveDate: text("effective_date"),
    url: text("url").notNull(),
    contentHash: text("content_hash").notNull(),
    rawText: text("raw_text").notNull(),
    /** The text before the latest amendment, so a digest can say what changed. Null for a rule seen once. */
    previousRawText: text("previous_raw_text"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastChangedAt: ts("last_changed_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("rules_source_external_idx").on(t.sourceId, t.externalId)],
);

/** A plain-language summary of one version of a rule (see `RuleDigest` in graph/types). */
export const ruleDigests = pgTable(
  "rule_digests",
  {
    id: id(),
    ruleId: bigint("rule_id", { mode: "number" })
      .notNull()
      .references(() => rules.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    kind: text("kind", { enum: ["new", "amended"] }).notNull(),
    digest: jsonb("digest").$type<RuleDigestJson>().notNull(),
    analyst: text("analyst").notNull(),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("rule_digests_rule_hash_idx").on(t.ruleId, t.contentHash), index("rule_digests_rule_id_idx").on(t.ruleId)],
);

export type RuleDigestJson = {
  summary: string;
  what_changed: string;
  effective_date: string | null;
  applies_to: string;
  key_obligations: string[];
};
export type RuleDigestRow = typeof ruleDigests.$inferSelect;

export const ruleChunks = pgTable(
  "rule_chunks",
  {
    id: id(),
    ruleId: bigint("rule_id", { mode: "number" })
      .notNull()
      .references(() => rules.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    sectionRef: text("section_ref"),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("rule_chunks_rule_id_idx").on(t.ruleId),
    index("rule_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const codeChunks = pgTable(
  "code_chunks",
  {
    id: id(),
    repo: text("repo").notNull(),
    commitSha: text("commit_sha").notNull(),
    path: text("path").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  },
  (t) => [
    index("code_chunks_repo_path_idx").on(t.repo, t.path),
    index("code_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const auditRuns = pgTable("audit_runs", {
  id: id(),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  status: text("status", { enum: ["running", "completed", "skipped", "failed"] }).notNull(),
  trigger: text("trigger", { enum: ["cron", "manual"] }).notNull(),
  rulesInScope: integer("rules_in_scope").array().notNull().default([]),
  reportUrl: text("report_url"),
  costUsd: doublePrecision("cost_usd").notNull().default(0),
  error: text("error"),
  /** Why a run ended without auditing anything, e.g. a skip. Shown on the dashboard. */
  note: text("note"),
});

export const findings = pgTable(
  "findings",
  {
    id: id(),
    runId: bigint("run_id", { mode: "number" })
      .notNull()
      .references(() => auditRuns.id, { onDelete: "cascade" }),
    ruleId: bigint("rule_id", { mode: "number" })
      .notNull()
      .references(() => rules.id),
    obligation: text("obligation").notNull(),
    status: text("status", { enum: ["compliant", "violation", "needs_review"] }).notNull(),
    severity: text("severity", { enum: ["critical", "high", "medium", "low"] }).notNull(),
    evidence: jsonb("evidence").$type<CodeEvidence[]>().notNull().default([]),
    citationChunkIds: integer("citation_chunk_ids").array().notNull().default([]),
    rationale: text("rationale").notNull(),
  },
  (t) => [index("findings_run_id_idx").on(t.runId), index("findings_rule_id_idx").on(t.ruleId)],
);

/** Embedding cache keyed by sha256(model + input type + text). */
export const embeddingCache = pgTable("embedding_cache", {
  hash: text("hash").primaryKey(),
  model: text("model").notNull(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
});

export type Rule = typeof rules.$inferSelect;
export type RuleChunk = typeof ruleChunks.$inferSelect;
export type CodeChunk = typeof codeChunks.$inferSelect;
export type AuditRun = typeof auditRuns.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;
