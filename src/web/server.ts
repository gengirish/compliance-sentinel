import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import type { Queue } from "bullmq";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { config } from "../config.js";
import { openMigratedDb, type Db } from "../db/client.js";
import { auditRuns } from "../db/schema.js";
import { errorMessage, log } from "../log.js";
import { createQueue, enqueueManualAudit, type AuditJobData } from "../queue/queue.js";
import { signReportUrl } from "../report/upload.js";

export type AppDeps = {
  db: Db;
  /** Lazily created so `/health` works even when Redis is down. */
  getQueue: () => Queue<AuditJobData>;
  token?: string;
};

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

  /** Manual trigger. `?demo=1` forces the bundled demo rules through. */
  app.post("/runs", async (c) => {
    const demo = ["1", "true"].includes(c.req.query("demo") ?? "");
    const jobId = await enqueueManualAudit(deps.getQueue(), { demo });
    log.info("manual audit enqueued", { jobId, demo });
    return c.json({ jobId, demo }, 202);
  });

  app.get("/runs", async (c) => {
    const rows = await deps.db.select().from(auditRuns).orderBy(desc(auditRuns.id)).limit(20);
    return c.json(rows);
  });

  /** Redirects to a freshly signed download link, or streams the local file in dev. */
  app.get("/reports/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid run id" }, 400);
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
