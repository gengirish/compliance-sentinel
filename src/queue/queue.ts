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
  /** Audit this public repository (shallow clone) instead of the configured target. */
  repoUrl?: string;
  /** With `repoUrl`: the branch, tag or sha to audit; absent means its default branch. */
  repoRef?: string;
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

export type ScheduledJob = typeof DAILY_JOB | typeof DIGEST_JOB;

/**
 * Queues today's daily audit or weekly digest, with the data the worker's job scheduler would
 * give it. The UTC date in the id makes a repeat on the same day (a late or doubled GitHub
 * cron, or a retried request) a no-op that reports the job already queued.
 */
export async function enqueueScheduledJob(
  queue: Queue<AuditJobData>,
  job: ScheduledJob,
  now = new Date(),
): Promise<{ queued: boolean; jobId: string }> {
  const jobId = `${job}-${now.toISOString().slice(0, 10)}`;
  if (await queue.getJob(jobId)) return { queued: false, jobId };
  const data: AuditJobData = job === DIGEST_JOB ? { trigger: "cron", kind: "digest" } : { trigger: "cron" };
  await queue.add(job, data, { jobId });
  return { queued: true, jobId };
}

/** A second manual digest inside this window is refused unless forced, so a double click or a retried request does not mail everyone twice. */
export const MANUAL_DIGEST_WINDOW_MS = 10 * 60 * 1000;

/** `queued: false` means a manual digest was already queued inside the window; `jobId` is that one. */
export type ManualDigestOutcome = { queued: boolean; jobId: string };

/**
 * Queues a one-off digest delivery now, to the same channels as the weekly run. Its own
 * unique id keeps it apart from the repeatable weekly job's. BullMQ's deduplication makes the
 * window check atomic: a duplicate add returns the existing job's id instead of creating one.
 */
export async function enqueueManualDigest(
  queue: Queue<AuditJobData>,
  opts: { force?: boolean } = {},
): Promise<ManualDigestOutcome> {
  if (opts.force) await queue.removeDeduplicationKey(MANUAL_DIGEST_JOB);
  const jobId = `${MANUAL_DIGEST_JOB}-${randomUUID()}`;
  const job = await queue.add(
    MANUAL_DIGEST_JOB,
    { trigger: "manual", kind: "digest" },
    { jobId, deduplication: { id: MANUAL_DIGEST_JOB, ttl: MANUAL_DIGEST_WINDOW_MS } },
  );
  return { queued: job.id === jobId, jobId: job.id! };
}
