/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed JSON responses */
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { tenants } from "../src/db/schema.js";
import { TENANT_HEADER } from "../src/db/tenants.js";
import { DAILY_JOB, DIGEST_JOB, enqueueScheduledJob, type AuditJobData } from "../src/queue/queue.js";
import { registerSchedules } from "../src/queue/schedule.js";
import { createApp } from "../src/web/server.js";

/** Keeps added jobs by id, as BullMQ does while they are retained. */
function fakeQueue() {
  const jobs = new Map<string, { name: string; data: AuditJobData }>();
  const add = vi.fn(async (name: string, data: AuditJobData, opts: { jobId: string }) => {
    if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, { name, data });
    return { id: opts.jobId };
  });
  const getJob = vi.fn(async (id: string) => jobs.get(id));
  return { jobs, add, queue: { add, getJob } as unknown as Queue<AuditJobData> };
}

describe("scheduled jobs", () => {
  it("queues one daily audit per UTC day, with the scheduler's data", async () => {
    const { jobs, add, queue } = fakeQueue();
    const morning = new Date("2026-11-12T06:00:05Z");
    expect(await enqueueScheduledJob(queue, DAILY_JOB, morning)).toEqual({ queued: true, jobId: "daily-audit-2026-11-12" });
    // GitHub fired late, twice, or the call was retried.
    expect(await enqueueScheduledJob(queue, DAILY_JOB, new Date("2026-11-12T06:40:00Z"))).toEqual({ queued: false, jobId: "daily-audit-2026-11-12" });
    expect(add).toHaveBeenCalledOnce();
    expect(jobs.get("daily-audit-2026-11-12")).toEqual({ name: DAILY_JOB, data: { trigger: "cron" } });

    expect((await enqueueScheduledJob(queue, DAILY_JOB, new Date("2026-11-13T06:00:00Z"))).queued).toBe(true);
  });

  it("queues the weekly digest as a digest job", async () => {
    const { jobs, queue } = fakeQueue();
    await enqueueScheduledJob(queue, DIGEST_JOB, new Date("2026-11-16T07:00:00Z"));
    expect(jobs.get("weekly-digest-2026-11-16")).toEqual({ name: DIGEST_JOB, data: { trigger: "cron", kind: "digest" } });
  });

  it("removes the worker's saved job schedulers when GitHub schedules", async () => {
    const removeJobScheduler = vi.fn(async () => true);
    const upsertJobScheduler = vi.fn();
    const queue = { removeJobScheduler, upsertJobScheduler } as unknown as Queue<AuditJobData>;
    await registerSchedules(queue, "github");
    expect(removeJobScheduler.mock.calls).toEqual([[DAILY_JOB], [DIGEST_JOB]]);
    expect(upsertJobScheduler).not.toHaveBeenCalled();
  });
});

describe("POST /scheduled/:job", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    await handle.db.insert(tenants).values({ name: "Acme", clerkOrgId: "org_acme" });
  });
  afterAll(() => handle.close());

  const auth = { authorization: "Bearer t" };
  const app = (queue: Queue<AuditJobData>) => createApp({ db: handle.db, getQueue: () => queue, token: "t" });

  it("queues the job once a day for the operator only", async () => {
    const { queue } = fakeQueue();
    const a = app(queue);
    const first = await a.request("/scheduled/daily-audit", { method: "POST", headers: auth });
    expect(first.status).toBe(202);
    const body = (await first.json()) as any;
    expect(body.queued).toBe(true);
    expect(body.jobId).toMatch(/^daily-audit-\d{4}-\d{2}-\d{2}$/);

    const again = await a.request("/scheduled/daily-audit", { method: "POST", headers: auth });
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).queued).toBe(false);

    expect((await a.request("/scheduled/weekly-digest", { method: "POST", headers: auth })).status).toBe(202);
    expect((await a.request("/scheduled/manual-audit", { method: "POST", headers: auth })).status).toBe(404);
    expect((await a.request("/scheduled/daily-audit", { method: "POST" })).status).toBe(401);
    const tenant = await a.request("/scheduled/daily-audit", { method: "POST", headers: { ...auth, [TENANT_HEADER]: "org_acme" } });
    expect(tenant.status).toBe(403);
  });
});
