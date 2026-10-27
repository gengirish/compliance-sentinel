import {
  bigint,
  boolean,
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

/** The operator's own tenant, seeded by migration 0004. CLI runs, evals and the GitHub Action use it. */
export const LOCAL_TENANT_ID = 1;

/** One customer: a GitHub App installation, optionally linked to a Clerk organization. */
export const tenants = pgTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  githubInstallationId: bigint("github_installation_id", { mode: "number" }).unique(),
  clerkOrgId: text("clerk_org_id").unique(),
  /** Fixture prefixes this tenant is audited against; empty means no restriction. */
  rulePacks: text("rule_packs").array().notNull().default(["pci"]),
  monthlyBudgetUsd: doublePrecision("monthly_budget_usd").notNull().default(25),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const repos = pgTable(
  "repos",
  {
    id: id(),
    tenantId: bigint("tenant_id", { mode: "number" })
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).unique(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch"),
    /** The last completed audit of the default branch; PR runs are compared with it. */
    baselineRunId: bigint("baseline_run_id", { mode: "number" }),
    baselineSha: text("baseline_sha"),
    active: boolean("active").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("repos_tenant_id_full_name_key").on(t.tenantId, t.fullName)],
);

export const sources = pgTable("sources", {
  id: id(),
  name: text("name").notNull().unique(),
  kind: text("kind", { enum: ["api", "playwright", "fixture"] }).notNull(),
  url: text("url").notNull(),
  lastCheckedAt: ts("last_checked_at"),
});

/** Dashboard switches for the scrapers, by source name. No row: the SCRAPE_* flag decides. */
export const sourceSettings = pgTable("source_settings", {
  name: text("name").primaryKey(),
  enabled: boolean("enabled").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
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
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    path: text("path").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  },
  (t) => [
    index("code_chunks_repo_commit_path_idx").on(t.repoId, t.commitSha, t.path),
    index("code_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const TRIGGERS = ["cron", "manual", "install", "pull_request", "push"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const auditRuns = pgTable("audit_runs", {
  id: id(),
  tenantId: bigint("tenant_id", { mode: "number" })
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  repoId: bigint("repo_id", { mode: "number" }).references(() => repos.id, { onDelete: "set null" }),
  /** The commit audited, once the repository has been indexed. */
  headSha: text("head_sha"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  status: text("status", { enum: ["running", "completed", "skipped", "failed"] }).notNull(),
  trigger: text("trigger", { enum: TRIGGERS }).notNull(),
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

export type Tenant = typeof tenants.$inferSelect;
export type Repo = typeof repos.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type RuleChunk = typeof ruleChunks.$inferSelect;
export type CodeChunk = typeof codeChunks.$inferSelect;
export type AuditRun = typeof auditRuns.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;
