/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed JSON responses */
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { digestSubscribers, tenants } from "../src/db/schema.js";
import { TENANT_HEADER } from "../src/db/tenants.js";
import { OfflineAnalyst } from "../src/llm/offlineAnalyst.js";
import type { OutgoingMessage } from "../src/notify/agentmail.js";
import { loadDemoRules } from "../src/pipeline/run.js";
import { MANUAL_DIGEST_JOB, type AuditJobData } from "../src/queue/queue.js";
import { persistChanges, upsertSource } from "../src/scrape/diff.js";
import { createApp, type AppDeps } from "../src/web/server.js";

const auth = { authorization: "Bearer t", "content-type": "application/json" };

describe("operator digest API", () => {
  let handle: DbHandle;
  let rulesSeeded = 0;

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    for (const { def, rules } of loadDemoRules()) {
      const sourceId = await upsertSource(handle.db, def);
      rulesSeeded += (await persistChanges(handle.db, sourceId, rules)).changed.length;
    }
    await handle.db.insert(digestSubscribers).values([
      { email: "a@example.com", token: "token-a-000000000000", status: "active" },
      { email: "b@example.com", token: "token-b-000000000000", status: "active" },
      { email: "c@example.com", token: "token-c-000000000000", status: "pending" },
      { email: "d@example.com", token: "token-d-000000000000", status: "unsubscribed" },
    ]);
    await handle.db.insert(tenants).values({ name: "Acme", clerkOrgId: "org_acme" });
  });
  afterAll(() => handle.close());

  const app = (overrides: Partial<AppDeps> = {}) =>
    createApp({
      db: handle.db,
      getQueue: () => ({}) as Queue<AuditJobData>,
      token: "t",
      digestAnalyst: new OfflineAnalyst(),
      ...overrides,
    });
  const post = (a: ReturnType<typeof app>, path: string, body?: unknown, headers: Record<string, string> = auth) =>
    a.request(path, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });

  it("reports subscriber counts and delivery settings", async () => {
    const res = await app({ sendMail: vi.fn() }).request("/digest", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({
      subscribers: { active: 2, pending: 1, unsubscribed: 1 },
      schedule: config.DIGEST_CRON,
      days: config.DIGEST_DAYS,
      emailConfigured: true,
      teamRecipients: (config.ALERT_EMAIL_TO ?? "").split(",").filter((s) => s.trim()).length,
      slackConfigured: Boolean(config.SLACK_WEBHOOK_URL),
    });
    expect(((await (await app().request("/digest", { headers: auth })).json()) as any).emailConfigured).toBe(false);
  });

  it("is for the operator only", async () => {
    const add = vi.fn();
    const a = app({ sendMail: vi.fn(), getQueue: () => ({ add }) as unknown as Queue<AuditJobData> });
    const other = { ...auth, [TENANT_HEADER]: "org_acme" };
    const get = await a.request("/digest", { headers: other });
    expect(get.status).toBe(403);
    expect(((await get.json()) as any).error).toMatch(/operator/);
    expect((await post(a, "/digest/preview", {}, other)).status).toBe(403);
    expect((await post(a, "/digest/test", { email: "x@example.com" }, other)).status).toBe(403);
    expect((await post(a, "/digest/send", undefined, other)).status).toBe(403);
    expect(add).not.toHaveBeenCalled();
    expect((await a.request("/digest")).status).toBe(401);
  });

  it("previews the digest with the subscriber footer and sends nothing", async () => {
    const sendMail = vi.fn(async () => ({}));
    const a = app({ sendMail });
    for (const body of [undefined, {}, { days: 3 }]) {
      const res = await post(a, "/digest/preview", body);
      expect(res.status).toBe(200);
      const preview = (await res.json()) as any;
      expect(Object.keys(preview).sort()).toEqual(["costUsd", "errors", "from", "html", "rules", "subject", "text", "to"]);
      expect(preview.rules).toBe(rulesSeeded);
      expect(preview.costUsd).toBe(0);
      expect(preview.errors).toEqual([]);
      expect(preview.subject).toMatch(/^\[Compliance Sentinel\] Regulatory digest/);
      expect(preview.html).toContain("Unsubscribe");
      expect(preview.text).toContain("/unsubscribe?token=preview");
    }
    expect(sendMail).not.toHaveBeenCalled();
    expect((await post(a, "/digest/preview", { days: 0 })).status).toBe(400);
    expect((await post(a, "/digest/preview", { days: 91 })).status).toBe(400);
    expect((await post(a, "/digest/preview", { extra: 1 })).status).toBe(400);
  });

  it("sends one test copy to the given address only", async () => {
    const sendMail = vi.fn(async (_m: OutgoingMessage) => ({}));
    const a = app({ sendMail });
    const res = await post(a, "/digest/test", { email: "ops@example.com", days: 7 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ sentTo: "ops@example.com", rules: rulesSeeded, subject: expect.stringMatching(/^\[Test\] \[Compliance Sentinel\]/) });
    expect(sendMail).toHaveBeenCalledOnce();
    const message = sendMail.mock.calls[0]![0];
    expect(message.to).toEqual(["ops@example.com"]);
    expect(message.subject).toBe(body.subject);
    expect(message.text).toContain("Unsubscribe:");

    const bad = await post(a, "/digest/test", { email: "not-an-email" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).issues[0].path).toBe("email");
    expect((await post(a, "/digest/test", {})).status).toBe(400);
    expect(sendMail).toHaveBeenCalledOnce();

    const unconfigured = await post(app(), "/digest/test", { email: "ops@example.com" });
    expect(unconfigured.status).toBe(503);
    expect(((await unconfigured.json()) as any).error).toBeTruthy();
  });

  it("queues an immediate one-off digest delivery", async () => {
    let n = 0;
    const add = vi.fn(async (_name: string, _data: AuditJobData, opts: { jobId: string }) => ({ id: opts.jobId, n: ++n }));
    const a = app({ getQueue: () => ({ add }) as unknown as Queue<AuditJobData> });
    const first = await post(a, "/digest/send");
    expect(first.status).toBe(202);
    const { jobId } = (await first.json()) as any;
    expect(typeof jobId).toBe("string");
    expect(add).toHaveBeenCalledWith(MANUAL_DIGEST_JOB, { trigger: "manual", kind: "digest" }, { jobId });

    // Each send is its own job, never deduplicated against the weekly one or a previous send.
    const second = (await (await post(a, "/digest/send")).json()) as any;
    expect(second.jobId).not.toBe(jobId);
    expect(jobId).not.toBe("weekly-digest");
  });
});
