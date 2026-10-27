import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { config, resolveFromRoot, ROOT_DIR, targetRepoPath } from "../config.js";
import { openMigratedDb, type DbHandle } from "../db/client.js";
import { auditRuns, rules as rulesTable, type Rule } from "../db/schema.js";
import type { RuleDigestRecord } from "../digest/digestRule.js";
import { buildAuditGraph, runAuditGraph } from "../graph/graph.js";
import type { AuditStateType, GraphDeps } from "../graph/state.js";
import type { FindingSummary } from "../graph/types.js";
import { Budget, type Analyst } from "../llm/analyst.js";
import { ClaudeAnalyst } from "../llm/claudeAnalyst.js";
import { OfflineAnalyst } from "../llm/offlineAnalyst.js";
import { errorMessage, log } from "../log.js";
import { notifyCritical } from "../notify/index.js";
import { createEmbedder, type Embedder } from "../rag/embed.js";
import { indexRepo } from "../rag/indexRepo.js";
import { embedRule, getRulesByIds } from "../rag/retrieve.js";
import { renderReport } from "../report/render.js";
import { ASIC_SOURCE, fetchAsicRules } from "../scrape/asicTracker.js";
import { persistChanges, upsertSource, type ScrapedRule, type SourceDef } from "../scrape/diff.js";
import { ESMA_SOURCE, fetchEsmaRules } from "../scrape/esmaNews.js";
import { EUR_LEX_SOURCE, scrapeEurLex } from "../scrape/eurLex.playwright.js";
import { FCA_SOURCE, fetchFcaRules } from "../scrape/fcaPublications.js";
import { FEDERAL_REGISTER_SOURCE, fetchFederalRegisterRules } from "../scrape/federalRegister.js";
import { fetchFinraRules, FINRA_SOURCE } from "../scrape/finraNotices.js";
import { MAS_SOURCE, scrapeMasCirculars } from "../scrape/masCirculars.playwright.js";
import { fetchSecRules, SEC_SOURCE } from "../scrape/secRules.js";

const run = promisify(execFile);

export type PipelineOptions = {
  trigger: "cron" | "manual";
  /** "audit" (default) maps obligations to code; "digest" only summarises the rules in scope. */
  mode?: "audit" | "digest";
  /** Force the bundled demo rules through, regardless of content hashes. */
  demo?: boolean;
  /** Audit these stored rules instead of scraping. */
  ruleIds?: number[];
  /** Injected in tests; defaults are built from the environment. */
  handle?: DbHandle;
  analyst?: Analyst;
  embedder?: Embedder;
  deps?: Partial<Pick<GraphDeps, "renderReport" | "notify">>;
  sources?: { def: SourceDef; fetch: () => Promise<ScrapedRule[]> }[];
  repoPath?: string;
  /** Clone this repository for the run instead of using TARGET_REPO_PATH / TARGET_REPO_URL. */
  repoUrl?: string;
  /** Commit sha (or branch/tag) to audit when cloning; defaults to the remote's default branch. */
  repoRef?: string;
};

export const SKIP_NOTE = "No new or amended rules since the last check, so there was nothing to audit.";
export const DIGEST_NOTE = "Digest run: the rules in scope were summarised for people, not audited against code.";

export type PipelineResult = {
  runId: number;
  status: "completed" | "skipped";
  rulesInScope: number[];
  /** Filled in digest mode. */
  digests: RuleDigestRecord[];
  summary: FindingSummary | null;
  reportUrl: string | null;
  reportPath: string | null;
  costUsd: number;
  errors: string[];
  notified: string[];
  state?: AuditStateType;
};

const FixtureSchema = z.object({
  source: z.object({ name: z.string(), url: z.string() }),
  externalId: z.string(),
  title: z.string(),
  effectiveDate: z.string().nullable(),
  url: z.string(),
  rawText: z.string(),
});

/** Demo rules shipped with the repo, grouped by the source they stand in for. */
export function loadDemoRules(dir = path.join(ROOT_DIR, "fixtures", "rules")) {
  const bySource = new Map<string, { def: SourceDef; rules: ScrapedRule[] }>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const fixture = FixtureSchema.parse(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
    const name = `${fixture.source.name}-demo`;
    const entry = bySource.get(name) ?? { def: { name, kind: "fixture" as const, url: fixture.source.url }, rules: [] };
    entry.rules.push({
      externalId: fixture.externalId,
      title: fixture.title,
      effectiveDate: fixture.effectiveDate,
      url: fixture.url,
      rawText: fixture.rawText,
    });
    bySource.set(name, entry);
  }
  return [...bySource.values()];
}

export function defaultSources(): NonNullable<PipelineOptions["sources"]> {
  const sources: NonNullable<PipelineOptions["sources"]> = [
    { def: FEDERAL_REGISTER_SOURCE, fetch: () => fetchFederalRegisterRules() },
  ];
  if (config.SCRAPE_SEC) sources.push({ def: SEC_SOURCE, fetch: () => fetchSecRules() });
  if (config.SCRAPE_FINRA) sources.push({ def: FINRA_SOURCE, fetch: () => fetchFinraRules() });
  if (config.SCRAPE_FCA) sources.push({ def: FCA_SOURCE, fetch: () => fetchFcaRules() });
  if (config.SCRAPE_ESMA) sources.push({ def: ESMA_SOURCE, fetch: () => fetchEsmaRules() });
  if (config.SCRAPE_ASIC) sources.push({ def: ASIC_SOURCE, fetch: () => fetchAsicRules() });
  if (config.SCRAPE_EURLEX) sources.push({ def: EUR_LEX_SOURCE, fetch: () => scrapeEurLex() });
  if (config.SCRAPE_MAS) sources.push({ def: MAS_SOURCE, fetch: () => scrapeMasCirculars() });
  return sources;
}

export function createAnalyst(): Analyst {
  if (config.ANTHROPIC_API_KEY) return new ClaudeAnalyst();
  log.warn("ANTHROPIC_API_KEY not set: using the offline keyword baseline instead of Claude");
  return new OfflineAnalyst();
}

async function createCheckpointer(handle: DbHandle): Promise<{ saver: BaseCheckpointSaver; close: () => Promise<void> }> {
  if (handle.driver === "postgres" && config.DATABASE_URL) {
    const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
    const saver = PostgresSaver.fromConnString(config.DATABASE_URL);
    await saver.setup();
    return { saver, close: () => saver.end() };
  }
  // The embedded dev database has no pg pool for PostgresSaver, so checkpoints stay in memory.
  return { saver: new MemorySaver(), close: async () => undefined };
}

/** "https://github.com/owner/name(.git)" -> "owner/name"; other URLs -> their last two path segments. */
export function repoNameFromUrl(url: string): string {
  const parts = url
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter(Boolean);
  return parts.slice(-2).join("/");
}

/** Shallow-clones `url` at `ref` (a sha, branch or tag) into its own folder under .data/repos. */
export async function cloneRepo(url: string, ref?: string): Promise<string> {
  const dir = path.join(resolveFromRoot(".data/repos"), repoNameFromUrl(url).replace(/[^\w.-]+/g, "__"));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => run("git", ["-C", dir, ...args], { timeout: 300_000 });
  await git("init", "--quiet");
  await git("remote", "add", "origin", url);
  // Fetching a single ref at depth 1 works for branch names, tags and (on GitHub) full commit shas.
  await git("fetch", "--quiet", "--depth", "1", "origin", ref ?? "HEAD");
  await git("checkout", "--quiet", "--detach", "FETCH_HEAD");
  return dir;
}

type TargetRepo = { path: string; name?: string };

/** An explicit path or URL wins; then TARGET_REPO_PATH, then TARGET_REPO_URL, then the demo app. */
async function resolveTargetRepo(opts: Pick<PipelineOptions, "repoPath" | "repoUrl" | "repoRef">): Promise<TargetRepo> {
  if (opts.repoPath) return { path: opts.repoPath };
  if (opts.repoUrl) return { path: await cloneRepo(opts.repoUrl, opts.repoRef), name: repoNameFromUrl(opts.repoUrl) };
  if (!config.TARGET_REPO_PATH && config.TARGET_REPO_URL) {
    return { path: await cloneRepo(config.TARGET_REPO_URL), name: repoNameFromUrl(config.TARGET_REPO_URL) };
  }
  const dir = targetRepoPath();
  if (!existsSync(dir)) throw new Error(`target repository not found at ${dir}`);
  return { path: dir };
}

/** Scrape -> diff -> persist. Returns only rules that are new or amended. */
async function collectChangedRules(handle: DbHandle, opts: PipelineOptions): Promise<Rule[]> {
  const { db } = handle;
  if (opts.ruleIds?.length) return getRulesByIds(db, opts.ruleIds);

  const changed: Rule[] = [];
  if (opts.demo) {
    for (const { def, rules } of loadDemoRules()) {
      const sourceId = await upsertSource(db, def);
      changed.push(...(await persistChanges(db, sourceId, rules, { force: true })).changed);
    }
    return changed;
  }

  for (const source of opts.sources ?? defaultSources()) {
    try {
      const scraped = await source.fetch();
      if (scraped.length === 0) log.warn("source returned zero rules; the scraper may be broken", { source: source.def.name });
      const sourceId = await upsertSource(db, source.def);
      const result = await persistChanges(db, sourceId, scraped);
      log.info("source checked", {
        source: source.def.name,
        scraped: scraped.length,
        new: result.changes.filter((c) => c.kind === "new").length,
        amended: result.changes.filter((c) => c.kind === "amended").length,
      });
      changed.push(...result.changed);
    } catch (err) {
      // One broken portal must not stop the other source from being audited.
      log.error("source failed", { source: source.def.name, error: errorMessage(err) });
    }
  }
  return changed;
}

/** The whole daily job: scrape, diff, embed, audit, report, alert. */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const handle = opts.handle ?? (await openMigratedDb());
  const { db } = handle;
  const ownsHandle = !opts.handle;
  let runId: number | undefined;
  let scope: number[] = [];
  let checkpointer: Awaited<ReturnType<typeof createCheckpointer>> | undefined;

  try {
    const changedRules = await collectChangedRules(handle, opts);
    const rulesInScope = changedRules.map((r) => r.id);
    scope = rulesInScope;

    if (changedRules.length === 0) {
      const [row] = await db
        .insert(auditRuns)
        .values({ status: "skipped", trigger: opts.trigger, finishedAt: sql`now()`, note: SKIP_NOTE })
        .returning({ id: auditRuns.id });
      log.info("no new or amended rules; audit skipped", { runId: row!.id });
      return {
        runId: row!.id,
        status: "skipped",
        rulesInScope: [],
        digests: [],
        summary: null,
        reportUrl: null,
        reportPath: null,
        costUsd: 0,
        errors: [],
        notified: [],
      };
    }

    const [row] = await db
      .insert(auditRuns)
      .values({ status: "running", trigger: opts.trigger, rulesInScope })
      .returning({ id: auditRuns.id });
    runId = row!.id;
    log.info("audit run started", { runId, rules: rulesInScope.length, trigger: opts.trigger });

    const mode = opts.mode ?? "audit";
    const embedder = opts.embedder ?? createEmbedder(db);
    const analyst = opts.analyst ?? createAnalyst();
    let repo = "";
    let commitSha = "";
    if (mode === "audit") {
      for (const rule of changedRules) {
        const chunks = await embedRule(db, embedder, rule);
        log.info("rule embedded", { ruleId: rule.id, chunks });
      }
      const target = await resolveTargetRepo(opts);
      const index = await indexRepo(db, embedder, target.path, target.name);
      repo = index.repo;
      commitSha = index.commitSha;
    }

    checkpointer = await createCheckpointer(handle);
    const deps: GraphDeps = {
      db,
      embedder,
      analyst,
      budget: new Budget(config.MAX_RUN_COST_USD),
      renderReport: opts.deps?.renderReport ?? ((state) => renderReport(db, { ...state, analyst: analyst.name })),
      notify: opts.deps?.notify ?? notifyCritical,
    };
    const graph = buildAuditGraph(deps, { checkpointer: checkpointer.saver });
    const state = await runAuditGraph(
      graph,
      { runId, trigger: opts.trigger, mode, ruleIds: rulesInScope, repo, commitSha },
      { concurrency: config.AUDIT_CONCURRENCY },
    );

    await db
      .update(auditRuns)
      .set({
        status: "completed",
        finishedAt: sql`now()`,
        reportUrl: state.reportPath,
        costUsd: state.costUsd,
        error: state.errors.length ? state.errors.join("\n").slice(0, 4_000) : null,
        ...(mode === "digest" ? { note: DIGEST_NOTE } : {}),
      })
      .where(eq(auditRuns.id, runId));
    log.info("audit run completed", { runId, mode, costUsd: state.costUsd, digests: state.digests.length, ...state.summary });

    return {
      runId,
      status: "completed",
      rulesInScope,
      digests: state.digests,
      summary: state.summary,
      reportUrl: state.reportUrl,
      reportPath: state.reportPath,
      costUsd: state.costUsd,
      errors: state.errors,
      notified: state.notified,
      state,
    };
  } catch (err) {
    if (runId !== undefined) {
      await db
        .update(auditRuns)
        .set({ status: "failed", finishedAt: sql`now()`, error: errorMessage(err).slice(0, 4_000) })
        .where(eq(auditRuns.id, runId))
        .catch(() => undefined);
    }
    if (scope.length > 0 && !opts.ruleIds?.length) {
      // The rules were stored before the audit failed. Invalidate their hashes so the
      // retry (or tomorrow's run) sees them as changed instead of skipping them.
      await db
        .update(rulesTable)
        .set({ contentHash: sql`'unaudited:' || ${rulesTable.contentHash}` })
        .where(inArray(rulesTable.id, scope))
        .catch(() => undefined);
    }
    throw err;
  } finally {
    await checkpointer?.close().catch(() => undefined);
    if (ownsHandle) await handle.close();
  }
}
