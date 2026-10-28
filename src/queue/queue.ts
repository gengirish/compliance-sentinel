import { randomUUID } from "node:crypto";
import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";
import type { Trigger } from "../db/schema.js";

export const QUEUE_NAME = "compliance";
export const DAILY_JOB = "daily-audit";
export const MANUAL_JOB = "manual-audit";
export const DIGEST_JOB = "weekly-digest";
export const MANUAL_DIGEST_JOB = "manual-digest";
export const INSTALL_JOB = "install-baseline";

export type AuditJobData = {
  trigger: Trigger;
  /** Whose audit this is; absent means the operator's local tenant. */
  tenantId?: number;
  /** "audit" (default) runs the pipeline; "digest" sends the weekly round-up of rule changes. */
  kind?: "audit" | "digest";
  /** Audit this repository of the tenant, cloned with the GitHub App, instead of the configured target. */
  repoId?: number;
  demo?: boolean;
  /** With `demo`: only the bundled rules whose file names start with one of these. Empty: all of them. */
  rulePacks?: string[];
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

/**
 * Queues a one-off digest delivery now, to the same channels as the weekly run. Its own
 * unique id keeps it apart from the repeatable weekly job's.
 */
export async function enqueueManualDigest(queue: Queue<AuditJobData>): Promise<string> {
  const job = await queue.add(MANUAL_DIGEST_JOB, { trigger: "manual", kind: "digest" }, { jobId: `${MANUAL_DIGEST_JOB}-${randomUUID()}` });
  return job.id!;
}
