import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import type { Queue } from "bullmq";
import { and, count, desc, eq, inArray, max, type SQL } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { ZodError, type z } from "zod";
import { config } from "../config.js";
import { openMigratedDb, type Db } from "../db/client.js";
import { auditRuns, findings, LOCAL_TENANT_ID, ruleChunks, rules, sources } from "../db/schema.js";
import { resolveTenantId, TENANT_HEADER } from "../db/tenants.js";
import { verifyGitHubSignature } from "../github/app.js";
import { handleGitHubEvent } from "../github/webhook.js";
import type { Severity, Status } from "../graph/types.js";
import { errorMessage, log } from "../log.js";
import { AgentMailClient, parseInboundCommand, senderAddress, verifyWebhookSignature, WebhookEvent } from "../notify/agentmail.js";
import { failStaleRuns } from "../pipeline/watchdog.js";
import { createQueue, enqueueManualAudit, INSTALL_JOB, type AuditJobData } from "../queue/queue.js";
import { signReportUrl } from "../report/upload.js";
import { describeIssues, FindingsQuery, ListRunsQuery, RunIdParams, TriggerRunQuery } from "./schemas.js";

export type AppDeps = {
  db: Db;
  /** Lazily created so `/health` works even when Redis is down. */
  getQueue: () => Queue<AuditJobData>;
  token?: string;
  /** When set, reads of run status first mark runs stuck longer than this as failed. */
  runTimeoutMinutes?: number;
  /** Mail sent to the app's AgentMail inbox. Unset: the inbound route answers 503. */
  inbound?: {
    /** Svix signing secret of the AgentMail webhook. */
    secret?: string;
    /** Lower-cased addresses whose "run audit" emails are acted on. */
    allowedSenders: string[];
    reply: (messageId: string, text: string) => Promise<unknown>;
  };
  /** Secret of the GitHub App's webhook. Unset: the webhook route answers 503. */
  githubWebhookSecret?: string;
};

export const INBOUND_PATH = "/inbox/agentmail";
export const GITHUB_WEBHOOK_PATH = "/github/webhook";

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

type Env = { Variables: { tenantId: number | null } };

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/health", (c) => c.json({ ok: true }));

  /**
   * AgentMail delivers mail sent to the app's inbox here. It is authenticated by
   * the webhook signature, not the trigger token. The only command understood is
   * a request to run an audit, and only from the configured alert recipients;
   * everything else is logged and acknowledged so AgentMail stops retrying.
   */
  app.post(INBOUND_PATH, async (c) => {
    const inbound = deps.inbound;
    if (!inbound?.secret) return c.json({ error: "AGENTMAIL_WEBHOOK_SECRET is not configured" }, 503);
    const raw = await c.req.text();
    const headers = { id: c.req.header("svix-id"), timestamp: c.req.header("svix-timestamp"), signature: c.req.header("svix-signature") };
    if (!verifyWebhookSignature(raw, headers, inbound.secret)) return c.json({ error: "invalid signature" }, 400);

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const event = WebhookEvent.safeParse(json);
    if (!event.success) return c.json({ error: "unexpected payload", issues: describeIssues(event.error) }, 400);
    const message = event.data.event_type === "message.received" ? event.data.message : undefined;
    if (!message) return c.body(null, 204);

    const from = senderAddress(message.from);
    const command = parseInboundCommand(message.subject, message.text ?? message.preview);
    log.info("inbound email", { from, subject: message.subject, messageId: message.message_id, command: command?.kind ?? null });
    if (!command) return c.body(null, 204);
    if (!from || !inbound.allowedSenders.includes(from)) {
      log.warn("inbound email asked for an audit from an address that is not an alert recipient; ignored", { from });
      return c.body(null, 204);
    }

    // Mail commands come from the operator's alert recipients, so they act for the local tenant.
    const jobId = await enqueueManualAudit(deps.getQueue(), { demo: command.demo, tenantId: LOCAL_TENANT_ID });
    log.info("manual audit enqueued by email", { jobId, demo: command.demo, from });
    const note = command.demo ? "A demo audit of the bundled rules is queued." : "An audit of the live sources is queued.";
    await inbound
      .reply(message.message_id, `${note} If it finds a critical violation you will get an alert email with the report attached; every run is in the dashboard.`)
      .catch((err) => log.warn("inbound email reply failed", { messageId: message.message_id, error: errorMessage(err) }));
    return c.body(null, 204);
  });

  /**
   * The GitHub App's webhook, authenticated by its HMAC signature. GitHub gives up after 10
   * seconds, so this only updates tenants and repos and queues work. The delivery id names
   * the queued jobs, which makes a redelivery a no-op.
   */
  app.post(GITHUB_WEBHOOK_PATH, async (c) => {
    if (!deps.githubWebhookSecret) return c.json({ error: "GITHUB_WEBHOOK_SECRET is not configured" }, 503);
    const raw = await c.req.text();
    if (!verifyGitHubSignature(raw, c.req.header("x-hub-signature-256"), deps.githubWebhookSecret)) {
      return c.json({ error: "invalid signature" }, 401);
    }
    const event = c.req.header("x-github-event") ?? "";
    const deliveryId = c.req.header("x-github-delivery") ?? "";
    if (!/^[\w-]+$/.test(deliveryId)) return c.json({ error: "missing x-github-delivery" }, 400);

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    let outcome: Awaited<ReturnType<typeof handleGitHubEvent>>;
    try {
      outcome = await handleGitHubEvent(deps.db, event, deliveryId, payload);
    } catch (err) {
      if (err instanceof ZodError) return c.json({ error: "unexpected payload", issues: describeIssues(err) }, 400);
      throw err;
    }
    for (const job of outcome.jobs) await deps.getQueue().add(INSTALL_JOB, job.data, { jobId: job.jobId });
    log.info("GitHub webhook", { event, deliveryId, summary: outcome.summary, queued: outcome.jobs.length });
    return c.json({ queued: outcome.jobs.length }, 202);
  });

  // Everything below needs the trigger token. With no token configured, the routes stay closed.
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.path === INBOUND_PATH || c.req.path === GITHUB_WEBHOOK_PATH) return next();
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

  /**
   * Every route below acts for one tenant, named by the header the dashboard sets. A header
   * that matches no tenant reads as empty and cannot trigger runs: it never falls back to
   * another tenant's data.
   */
  app.use("*", async (c, next) => {
    c.set("tenantId", await resolveTenantId(deps.db, c.req.header(TENANT_HEADER)));
    return next();
  });

  /** A run of this tenant, or undefined when it does not exist or belongs to someone else. */
  const findRun = async (tenantId: number | null, id: number) => {
    if (tenantId === null) return undefined;
    const [run] = await deps.db
      .select()
      .from(auditRuns)
      .where(and(eq(auditRuns.id, id), eq(auditRuns.tenantId, tenantId)));
    return run;
  };

  /** Manual trigger. `?demo=1` forces the bundled demo rules through. */
  app.post("/runs", async (c) => {
    const query = parseInput(c, TriggerRunQuery, c.req.query());
    if (!query.ok) return query.response;
    const tenantId = c.get("tenantId");
    if (tenantId === null) return c.json({ error: "no tenant is linked to this account; install the GitHub App first" }, 409);
    const { demo } = query.data;
    const jobId = await enqueueManualAudit(deps.getQueue(), { demo, tenantId });
    log.info("manual audit enqueued", { jobId, demo, tenantId });
    return c.json({ jobId, demo }, 202);
  });

  app.get("/runs", async (c) => {
    const query = parseInput(c, ListRunsQuery, c.req.query());
    if (!query.ok) return query.response;
    const tenantId = c.get("tenantId");
    if (tenantId === null) return c.json([]);
    const rows = await deps.db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.tenantId, tenantId))
      .orderBy(desc(auditRuns.id))
      .limit(20);
    if (!query.data.counts) return c.json(rows);
    const counts = await countFindings(
      deps.db,
      rows.map((r) => r.id),
    );
    return c.json(rows.map((r) => ({ ...r, counts: counts.get(r.id) })));
  });

  /** Dashboard summary: the latest run of any status, and the latest completed run with its finding counts. */
  app.get("/stats", async (c) => {
    // -1 matches no run: an unknown tenant gets zeros, not an error, so the dashboard can render.
    const mine = eq(auditRuns.tenantId, c.get("tenantId") ?? -1);
    const [latestRun] = await deps.db.select().from(auditRuns).where(mine).orderBy(desc(auditRuns.id)).limit(1);
    const [latestCompleted] = await deps.db
      .select()
      .from(auditRuns)
      .where(and(mine, eq(auditRuns.status, "completed")))
      .orderBy(desc(auditRuns.id))
      .limit(1);
    // Rule text is public and shared by every tenant.
    const [ruleCount] = await deps.db.select({ n: count() }).from(rules);
    const [runCount] = await deps.db.select({ n: count() }).from(auditRuns).where(mine);
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
    const run = await findRun(c.get("tenantId"), id);
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
    if (!(await findRun(c.get("tenantId"), id))) return c.json({ error: "run not found" }, 404);
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
    // Rules are shared; which run last audited one is not.
    const lastAudited = deps.db
      .select({ ruleId: findings.ruleId, runId: max(findings.runId).as("last_run_id") })
      .from(findings)
      .innerJoin(auditRuns, eq(findings.runId, auditRuns.id))
      .where(eq(auditRuns.tenantId, c.get("tenantId") ?? -1))
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
    const run = await findRun(c.get("tenantId"), id);
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
  const mail = AgentMailClient.fromConfig();
  const app = createApp({
    db: handle.db,
    getQueue: () => (queue ??= createQueue()),
    token: config.RUN_TRIGGER_TOKEN,
    runTimeoutMinutes: config.RUN_TIMEOUT_MINUTES,
    inbound: {
      secret: config.AGENTMAIL_WEBHOOK_SECRET,
      allowedSenders: (config.ALERT_EMAIL_TO ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      reply: (messageId, text) =>
        mail ? mail.reply(messageId, { text }) : Promise.reject(new Error("AgentMail is not configured, reply skipped")),
    },
    githubWebhookSecret: config.GITHUB_WEBHOOK_SECRET,
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
