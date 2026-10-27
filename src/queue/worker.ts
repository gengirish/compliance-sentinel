import { pathToFileURL } from "node:url";
import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { config } from "../config.js";
import { openMigratedDb } from "../db/client.js";
import { runWeeklyDigest } from "../digest/weekly.js";
import { errorMessage, log } from "../log.js";
import { runPipeline, type PipelineResult } from "../pipeline/run.js";
import { failStaleRuns } from "../pipeline/watchdog.js";
import { QUEUE_NAME, createConnection, createQueue, type AuditJobData } from "./queue.js";
import { registerDailyAudit, registerWeeklyDigest } from "./schedule.js";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type JobSummary = Pick<PipelineResult, "runId" | "status" | "summary" | "reportUrl" | "costUsd" | "notified"> & {
  /** Rules summarised, for digest jobs (which have no audit run). */
  digested?: number;
};

/** The job handler, separate from the Worker so it can be tested without Redis. */
export async function processAuditJob(
  data: AuditJobData,
  runner: typeof runPipeline = runPipeline,
  digestRunner: typeof runWeeklyDigest = runWeeklyDigest,
): Promise<JobSummary> {
  if (data.kind === "digest") {
    const digest = await digestRunner({ days: config.DIGEST_DAYS, send: true });
    return { runId: 0, status: "completed", summary: null, reportUrl: null, costUsd: digest.costUsd, notified: digest.notified, digested: digest.records.length };
  }
  const result = await runner({
    trigger: data.trigger,
    tenantId: data.tenantId,
    repoId: data.repoId,
    demo: data.demo,
    rulePacks: data.rulePacks,
    ruleIds: data.ruleIds,
  });
  return {
    runId: result.runId,
    status: result.status,
    summary: result.summary,
    reportUrl: result.reportUrl,
    costUsd: result.costUsd,
    notified: result.notified,
  };
}

export function startWorker(connection: ConnectionOptions = createConnection()): Worker<AuditJobData, JobSummary> {
  const worker = new Worker<AuditJobData, JobSummary>(
    QUEUE_NAME,
    (job: Job<AuditJobData>) => {
      log.info("job started", { jobId: job.id, name: job.name, attempt: job.attemptsMade + 1 });
      return processAuditJob(job.data);
    },
    {
      connection,
      concurrency: 1,
      // A run can take minutes; keep the lock well beyond that so it is not treated as stalled.
      lockDuration: 10 * 60 * 1000,
    },
  );

  worker.on("completed", (job, result) => {
    log.info("job completed", { jobId: job.id, name: job.name, ...result });
  });
  worker.on("failed", (job, err) => {
    const attempts = job?.opts.attempts ?? 1;
    if (job && job.attemptsMade >= attempts) {
      // Dead letter: BullMQ keeps the job in the failed set; this line is what to alert on.
      log.error("job dead-lettered after final attempt", {
        jobId: job.id,
        name: job.name,
        attempts: job.attemptsMade,
        data: job.data,
        error: errorMessage(err),
      });
    } else {
      log.warn("job attempt failed, will retry", { jobId: job?.id, attempt: job?.attemptsMade, error: errorMessage(err) });
    }
  });
  worker.on("error", (err) => log.error("worker error", { error: errorMessage(err) }));
  return worker;
}

async function main() {
  const queue = createQueue();
  await registerDailyAudit(queue);
  await registerWeeklyDigest(queue);

  // Reap runs orphaned by a previous crash or redeploy, then keep sweeping.
  const handle = await openMigratedDb();
  const sweep = () =>
    failStaleRuns(handle.db, { maxAgeMinutes: config.RUN_TIMEOUT_MINUTES }).catch((err) =>
      log.warn("stale run sweep failed", { error: errorMessage(err) }),
    );
  await sweep();
  const sweeper = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);

  const worker = startWorker();
  log.info("worker ready", { queue: QUEUE_NAME });

  const shutdown = async (signal: string) => {
    log.info("worker shutting down", { signal });
    clearInterval(sweeper);
    await worker.close();
    await queue.close();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log.error("worker failed to start", { error: errorMessage(err) });
    process.exit(1);
  });
}
