import { pathToFileURL } from "node:url";
import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { errorMessage, log } from "../log.js";
import { runPipeline, type PipelineResult } from "../pipeline/run.js";
import { QUEUE_NAME, createConnection, createQueue, type AuditJobData } from "./queue.js";
import { registerDailyAudit } from "./schedule.js";

export type JobSummary = Pick<PipelineResult, "runId" | "status" | "summary" | "reportUrl" | "costUsd" | "notified">;

/** The job handler, separate from the Worker so it can be tested without Redis. */
export async function processAuditJob(
  data: AuditJobData,
  runner: typeof runPipeline = runPipeline,
): Promise<JobSummary> {
  const result = await runner({ trigger: data.trigger, demo: data.demo, ruleIds: data.ruleIds });
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
  const worker = startWorker();
  log.info("worker ready", { queue: QUEUE_NAME });

  const shutdown = async (signal: string) => {
    log.info("worker shutting down", { signal });
    await worker.close();
    await queue.close();
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
