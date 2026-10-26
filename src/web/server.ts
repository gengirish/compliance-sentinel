import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import type { Queue } from "bullmq";
import { and, count, desc, eq, inArray, max, type SQL } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { z } from "zod";
import { config } from "../config.js";
import { openMigratedDb, type Db } from "../db/client.js";
import { auditRuns, findings, ruleChunks, rules, sources } from "../db/schema.js";
import type { Severity, Status } from "../graph/types.js";
import { errorMessage, log } from "../log.js";
import { failStaleRuns } from "../pipeline/watchdog.js";
import { createQueue, enqueueManualAudit, type AuditJobData } from "../queue/queue.js";
import { signReportUrl } from "../report/upload.js";
import { describeIssues, FindingsQuery, ListRunsQuery, RunIdParams, TriggerRunQuery } from "./schemas.js";

export type AppDeps = {
  db: Db;
  /** Lazily created so `/health` works even when Redis is down. */
  getQueue: () => Queue<AuditJobData>;
  token?: string;
  /** When set, reads of run status first mark runs stuck longer than this as failed. */
  runTimeoutMinutes?: number;
};

/** Run reads sweep for orphaned runs at most this often, so the dashboard never shows one as live. */
const SWEEP_EVERY_MS = 60_000;

type FindingCounts = {
  total: number;
  byStatus: Record<Status, number>;
  bySeverity: Record<Severity, number>;
  criticalViolations: number;
};

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** Validates request input against a schema, or builds the 400 response that names each bad field. */
function parseInput<S extends z.ZodType>(c: Context, schema: S, input: unknown): Parsed<z.infer<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, response: c.json({ error: "invalid request", issues: describeIssues(result.error) }, 400) };
}

async function countFindings(db: Db, runIds: number[]): Promise<Map<number, FindingCounts>> {
  const out = new Map<number, FindingCounts>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select({ runId: findings.runId, status: findings.status, severity: findings.severity, n: count() })
    .from(findings)
    .where(inArray(findings.runId, runIds))
    .groupBy(findings.runId, findings.status, findings.severity);
  for (const runId of runIds) {
    out.set(runId, {
      total: 0,
      byStatus: { compliant: 0, violation: 0, needs_review: 0 },
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      criticalViolations: 0,
    });
  }
  for (const r of rows) {
    const c = out.get(r.runId)!;
    c.total += r.n;
    c.byStatus[r.status] += r.n;
    c.bySeverity[r.severity] += r.n;
    if (r.status === "violation" && r.severity === "critical") c.criticalViolations += r.n;
  }
  return out;
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  // Everything below needs the trigger token. With no token configured, the routes stay closed.
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    if (!deps.token) return c.json({ error: "RUN_TRIGGER_TOKEN is not configured" }, 503);
    if (!tokenMatches(deps.token, c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  // The worker sweeps too, but if it is down a stuck run would otherwise read as live forever.
  let lastSweep = 0;
  app.use("*", async (c, next) => {
    const readsRuns = c.req.method === "GET" && (c.req.path === "/stats" || c.req.path.startsWith("/runs"));
    if (readsRuns && deps.runTimeoutMinutes && Date.now() - lastSweep > SWEEP_EVERY_MS) {
      lastSweep = Date.now();
      await failStaleRuns(deps.db, { maxAgeMinutes: deps.runTimeoutMinutes }).catch((err) =>
        log.warn("stale run sweep failed", { error: errorMessage(err) }),
      );
    }
    return next();
  });

  /** Manual trigger. `?demo=1` forces the bundled demo rules through. */
  app.post("/runs", async (c) => {
    const query = parseInput(c, TriggerRunQuery, c.req.query());
    if (!query.ok) return query.response;
    const { demo } = query.data;
    const jobId = await enqueueManualAudit(deps.getQueue(), { demo });
    log.info("manual audit enqueued", { jobId, demo });
    return c.json({ jobId, demo }, 202);
  });

  app.get("/runs", async (c) => {
    const query = parseInput(c, ListRunsQuery, c.req.query());
    if (!query.ok) return query.response;
    const rows = await deps.db.select().from(auditRuns).orderBy(desc(auditRuns.id)).limit(20);
    if (!query.data.counts) return c.json(rows);
    const counts = await countFindings(
      deps.db,
      rows.map((r) => r.id),
    );
    return c.json(rows.map((r) => ({ ...r, counts: counts.get(r.id) })));
  });

  /** Dashboard summary: the latest run of any status, and the latest completed run with its finding counts. */
  app.get("/stats", async (c) => {
    const [latestRun] = await deps.db.select().from(auditRuns).orderBy(desc(auditRuns.id)).limit(1);
    const [latestCompleted] = await deps.db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.status, "completed"))
      .orderBy(desc(auditRuns.id))
      .limit(1);
    const [ruleCount] = await deps.db.select({ n: count() }).from(rules);
    const [runCount] = await deps.db.select({ n: count() }).from(auditRuns);
    const counts = latestCompleted ? (await countFindings(deps.db, [latestCompleted.id])).get(latestCompleted.id) : undefined;
    return c.json({
      latestRun: latestRun ?? null,
      latestCompletedRun: latestCompleted ? { ...latestCompleted, counts } : null,
      totals: { rules: ruleCount?.n ?? 0, runs: runCount?.n ?? 0 },
    });
  });

  app.get("/runs/:id", async (c) => {
    const params = parseInput(c, RunIdParams, c.req.param());
    if (!params.ok) return params.response;
    const { id } = params.data;
    const [run] = await deps.db.select().from(auditRuns).where(eq(auditRuns.id, id));
    if (!run) return c.json({ error: "run not found" }, 404);
    const counts = (await countFindings(deps.db, [id])).get(id);
    return c.json({ ...run, counts });
  });

  /** Findings for a run with their rule and resolved regulation citations. `?status=` and `?severity=` take comma lists. */
  app.get("/runs/:id/findings", async (c) => {
    const params = parseInput(c, RunIdParams, c.req.param());
    if (!params.ok) return params.response;
    const { id } = params.data;
    const query = parseInput(c, FindingsQuery, c.req.query());
    if (!query.ok) return query.response;
    const { status: statuses, severity: severities } = query.data;
    const where: SQL[] = [eq(findings.runId, id)];
    if (statuses.length) where.push(inArray(findings.status, statuses));
    if (severities.length) where.push(inArray(findings.severity, severities));

    const rows = await deps.db
      .select({
        finding: findings,
        rule: { id: rules.id, title: rules.title, url: rules.url, externalId: rules.externalId },
      })
      .from(findings)
      .innerJoin(rules, eq(findings.ruleId, rules.id))
      .where(and(...where))
      .orderBy(findings.id);

    const chunkIds = [...new Set(rows.flatMap((r) => r.finding.citationChunkIds))];
    const chunks = chunkIds.length
      ? await deps.db
          .select({ id: ruleChunks.id, sectionRef: ruleChunks.sectionRef, text: ruleChunks.text })
          .from(ruleChunks)
          .where(inArray(ruleChunks.id, chunkIds))
      : [];
    const byId = new Map(chunks.map((ch) => [ch.id, { id: ch.id, sectionRef: ch.sectionRef, excerpt: ch.text.slice(0, 600) }]));

    return c.json(
      rows.map(({ finding, rule }) => ({
        ...finding,
        rule,
        citations: finding.citationChunkIds.flatMap((cid) => byId.get(cid) ?? []),
      })),
    );
  });

  /** Tracked rules with their source and the last run that produced findings for them. */
  app.get("/rules", async (c) => {
    const lastAudited = deps.db
      .select({ ruleId: findings.ruleId, runId: max(findings.runId).as("last_run_id") })
      .from(findings)
      .groupBy(findings.ruleId)
      .as("last_audited");
    const rows = await deps.db
      .select({
        id: rules.id,
        externalId: rules.externalId,
        title: rules.title,
        url: rules.url,
        effectiveDate: rules.effectiveDate,
        firstSeenAt: rules.firstSeenAt,
        lastChangedAt: rules.lastChangedAt,
        source: { name: sources.name, kind: sources.kind },
        lastAuditedRunId: lastAudited.runId,
      })
      .from(rules)
      .innerJoin(sources, eq(rules.sourceId, sources.id))
      .leftJoin(lastAudited, eq(lastAudited.ruleId, rules.id))
      .orderBy(desc(rules.lastChangedAt));
    return c.json(rows);
  });

  /** Redirects to a freshly signed download link, or streams the local file in dev. */
  app.get("/reports/:id", async (c) => {
    const params = parseInput(c, RunIdParams, c.req.param());
    if (!params.ok) return params.response;
    const { id } = params.data;
    const [run] = await deps.db.select().from(auditRuns).where(eq(auditRuns.id, id));
    if (!run?.reportUrl) return c.json({ error: "no report for this run" }, 404);

    if (run.reportUrl.startsWith("s3://")) {
      return c.redirect(await signReportUrl(run.reportUrl, 300), 302);
    }
    if (!existsSync(run.reportUrl)) return c.json({ error: "report file is gone" }, 404);
    const type = path.extname(run.reportUrl) === ".pdf" ? "application/pdf" : "text/html; charset=utf-8";
    return c.body(readFileSync(run.reportUrl), 200, { "content-type": type });
  });

  app.onError((err, c) => {
    log.error("request failed", { path: c.req.path, error: errorMessage(err) });
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}

async function main() {
  const handle = await openMigratedDb();
  let queue: Queue<AuditJobData> | undefined;
  const app = createApp({
    db: handle.db,
    getQueue: () => (queue ??= createQueue()),
    token: config.RUN_TRIGGER_TOKEN,
    runTimeoutMinutes: config.RUN_TIMEOUT_MINUTES,
  });
  serve({ fetch: app.fetch, port: config.PORT, hostname: "0.0.0.0" }, (info) => {
    log.info("web listening", { port: info.port });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log.error("web failed to start", { error: errorMessage(err) });
    process.exit(1);
  });
}
