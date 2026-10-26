import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";

export const QUEUE_NAME = "compliance";
export const DAILY_JOB = "daily-audit";
export const MANUAL_JOB = "manual-audit";
export const DIGEST_JOB = "weekly-digest";

export type AuditJobData = {
  trigger: "cron" | "manual";
  /** "audit" (default) runs the pipeline; "digest" sends the weekly round-up of rule changes. */
  kind?: "audit" | "digest";
  demo?: boolean;
  ruleIds?: number[];
};

export function createConnection(): ConnectionOptions {
  if (!config.REDIS_URL) throw new Error("REDIS_URL is not set");
  // BullMQ workers block on Redis, which requires maxRetriesPerRequest to be null.
  // The cast bridges the ioredis copy bundled inside bullmq and the one installed here.
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    family: 0, // resolve both A and AAAA: Fly private networking is IPv6-only
  }) as unknown as ConnectionOptions;
}

export function createQueue(connection: ConnectionOptions = createConnection()): Queue<AuditJobData> {
  return new Queue<AuditJobData>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 14 * 24 * 60 * 60, count: 200 },
      removeOnFail: { age: 30 * 24 * 60 * 60 },
    },
  });
}

export async function enqueueManualAudit(
  queue: Queue<AuditJobData>,
  data: Omit<AuditJobData, "trigger"> = {},
): Promise<string> {
  const job = await queue.add(MANUAL_JOB, { ...data, trigger: "manual" });
  return job.id!;
}
