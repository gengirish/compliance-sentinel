import type { Queue } from "bullmq";
import { config } from "../config.js";
import { log } from "../log.js";
import { DAILY_JOB, DIGEST_JOB, type AuditJobData } from "./queue.js";

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

/**
 * Sets up the daily audit and weekly digest for SCHEDULER. With "github" a GitHub Actions cron
 * triggers them through the API. Job schedulers persist in Redis, so the ones an earlier
 * deploy registered are removed, or they would keep firing as well.
 */
export async function registerSchedules(queue: Queue<AuditJobData>, scheduler = config.SCHEDULER): Promise<void> {
  if (scheduler === "github") {
    for (const id of [DAILY_JOB, DIGEST_JOB]) await queue.removeJobScheduler(id);
    log.info("worker schedules off: GitHub Actions triggers the daily audit and weekly digest");
    return;
  }
  await registerDailyAudit(queue);
  await registerWeeklyDigest(queue);
}

/** Registers (or updates) the weekly digest of rule changes, same upsert-by-id pattern. */
export async function registerWeeklyDigest(queue: Queue<AuditJobData>, cron = config.DIGEST_CRON): Promise<void> {
  await queue.upsertJobScheduler(
    DIGEST_JOB,
    { pattern: cron, tz: "UTC" },
    { name: DIGEST_JOB, data: { trigger: "cron", kind: "digest" } },
  );
  const schedulers = await queue.getJobSchedulers();
  const next = schedulers.find((s) => s.key === DIGEST_JOB)?.next;
  log.info("weekly digest scheduled", { cron, next: next ? new Date(next).toISOString() : null });
}
