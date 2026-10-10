import type { Queue } from "bullmq";
import { config } from "../config.js";
import { log } from "../log.js";
import { DAILY_JOB, type AuditJobData } from "./queue.js";

/**
 * Registers (or updates) the repeatable daily audit. Upserting by a fixed
 * scheduler id means redeploys and restarts never create duplicate schedules.
 */
export async function registerDailyAudit(queue: Queue<AuditJobData>, cron = config.AUDIT_CRON): Promise<void> {
  await queue.upsertJobScheduler(
    DAILY_JOB,
    { pattern: cron, tz: "UTC" },
    { name: DAILY_JOB, data: { trigger: "cron" } },
  );
  const schedulers = await queue.getJobSchedulers();
  const next = schedulers.find((s) => s.key === DAILY_JOB)?.next;
  log.info("daily audit scheduled", { cron, next: next ? new Date(next).toISOString() : null });
}
