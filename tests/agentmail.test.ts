import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { LOCAL_TENANT_ID } from "../src/db/schema.js";
import type { NotifyInput } from "../src/graph/state.js";
import {
  AgentMailClient,
  parseInboundCommand,
  senderAddress,
  signWebhook,
  verifyWebhookSignature,
  WebhookEvent,
} from "../src/notify/agentmail.js";
import { buildEmail, reportAttachment, sendEmailAlert } from "../src/notify/email.js";
import type { AuditJobData } from "../src/queue/queue.js";
import { createApp, INBOUND_PATH } from "../src/web/server.js";

const SECRET = `whsec_${Buffer.from("a-test-signing-key-of-32-bytes!!").toString("base64")}`;

const input: NotifyInput = {
  runId: 42,
  summary: {
    total: 2,
    byStatus: { compliant: 0, violation: 2, needs_review: 0 },
    violationsBySeverity: { critical: 1, high: 1, medium: 0, low: 0 },
    hasCritical: true,
  },
  findings: [
    {
      ruleId: 1,
      obligationId: "1-0",
      obligation: "Personal data must not be logged.",
      status: "violation",
      severity: "critical",
      rationale: "Logs the SSN.",
      evidence: [{ path: "src/a.js", start_line: 3, end_line: 4, excerpt: "console.log(ssn)" }],
      citationChunkIds: [1],
      verification: [],
    },
    {
      ruleId: 1,
      obligationId: "1-1",
      obligation: "High one.",
      status: "violation",
      severity: "high",
      rationale: "x",
      evidence: [],
      citationChunkIds: [1],
      verification: [],
    },
  ],
  reportUrl: "https://files.test/run-42.pdf?sig=abc",
};

/** A signed delivery as AgentMail (via Svix) would send it. */
function signedRequest(body: unknown, opts: { secret?: string; timestamp?: number } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const id = "msg_test";
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": signWebhook(raw, { id, timestamp }, opts.secret ?? SECRET),
    },
    body: raw,
  };
}

const received = (overrides: Record<string, unknown> = {}) => ({
  event_type: "message.received",
  event_id: "evt_1",
  message: {
    inbox_id: "alerts@example.com",
    message_id: "<abc@agentmail.to>",
    thread_id: "thd_1",
    from_: ["Ops Person <ops@example.com>"],
    to: ["alerts@example.com"],
    subject: "Please run the audit",
    text: "Can you run an audit today?\n\nThanks",
    ...overrides,
  },
});

describe("AgentMail webhook signatures", () => {
  it("accepts a signature over id.timestamp.body within the tolerance window", () => {
    const req = signedRequest({ hello: "world" });
    const headers = { id: req.headers["svix-id"], timestamp: req.headers["svix-timestamp"], signature: req.headers["svix-signature"] };
    expect(verifyWebhookSignature(req.body, headers, SECRET)).toBe(true);
    // Rotation: a space-separated list with an older signature first still verifies.
    expect(verifyWebhookSignature(req.body, { ...headers, signature: `v1,bogus ${headers.signature}` }, SECRET)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, a stale timestamp and missing headers", () => {
    const req = signedRequest({ hello: "world" });
    const headers = { id: req.headers["svix-id"], timestamp: req.headers["svix-timestamp"], signature: req.headers["svix-signature"] };
    expect(verifyWebhookSignature(req.body + " ", headers, SECRET)).toBe(false);
    expect(verifyWebhookSignature(req.body, headers, "whsec_b3RoZXI=")).toBe(false);
    const old = signedRequest({ hello: "world" }, { timestamp: Math.floor(Date.now() / 1000) - 10 * 60 });
    expect(verifyWebhookSignature(old.body, { id: "msg_test", timestamp: old.headers["svix-timestamp"], signature: old.headers["svix-signature"] }, SECRET)).toBe(false);
    expect(verifyWebhookSignature(req.body, { id: "msg_test" }, SECRET)).toBe(false);
  });

  it("reads the sender from either from_ or from, and the audit command from subject or body", () => {
    const parsed = WebhookEvent.parse(received());
    expect(parsed.message?.from).toEqual(["Ops Person <ops@example.com>"]);
    expect(senderAddress(parsed.message!.from)).toBe("ops@example.com");
    expect(WebhookEvent.parse(received({ from_: undefined, from: "jane@example.com" })).message?.from).toEqual(["jane@example.com"]);
    expect(parseInboundCommand("Please run the audit", "")).toEqual({ kind: "audit", demo: false });
    expect(parseInboundCommand("Re: status", "hi, could you kick off a demo audit?")).toEqual({ kind: "audit", demo: true });
    expect(parseInboundCommand("audit now", undefined)).toEqual({ kind: "audit", demo: false });
    expect(parseInboundCommand("Thanks for the audit report", "much appreciated")).toBeNull();
    expect(parseInboundCommand("Out of office", "")).toBeNull();
  });
});

describe("AgentMail client and email alert", () => {
  it("posts to the inbox send endpoint with the API key", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ message_id: "m1", thread_id: "t1" })) as unknown as typeof fetch;
    const client = new AgentMailClient({ apiKey: "key", inboxId: "alerts@example.com", baseUrl: "https://mail.test/v0", fetchImpl });
    const sent = await client.send({ to: ["ops@example.com"], subject: "s", text: "t" });
    expect(sent).toEqual({ messageId: "m1", threadId: "t1" });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mail.test/v0/inboxes/alerts%40example.com/messages/send");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key");
    expect(JSON.parse(init.body as string)).toEqual({ to: ["ops@example.com"], subject: "s", text: "t" });

    await client.reply("<abc@agentmail.to>", { text: "ok" });
    expect(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![0])).toBe(
      "https://mail.test/v0/inboxes/alerts%40example.com/messages/%3Cabc%40agentmail.to%3E/reply",
    );
  });

  it("fails loudly on an API error", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const client = new AgentMailClient({ apiKey: "key", inboxId: "a@b.c", fetchImpl });
    await expect(client.send({ to: ["x@y.z"], subject: "s", text: "t" })).rejects.toThrow("AgentMail HTTP 401");
  });

  it("is a dry run when AgentMail is not configured", async () => {
    expect(await sendEmailAlert(input, null)).toBe(false);
    expect(AgentMailClient.fromConfig({ apiKey: undefined, inboxId: "x@y.z" })).toBeNull();
  });

  it("builds a plain-text body alongside the HTML", () => {
    const email = buildEmail(input);
    expect(email.text).toContain("Audit run 42 found 2 violation(s): 1 critical");
    expect(email.text).toContain("- Personal data must not be logged. (src/a.js:3)");
    expect(email.text).not.toContain("High one.");
    expect(email.text).toContain("Full report: https://files.test/run-42.pdf?sig=abc");
  });

  it("attaches the PDF report when it is on disk and skips anything else", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sentinel-email-"));
    try {
      const pdf = path.join(dir, "run-42.pdf");
      writeFileSync(pdf, "%PDF-1.4 test");
      expect(reportAttachment(pdf)).toEqual({ filename: "run-42.pdf", content_type: "application/pdf", content: Buffer.from("%PDF-1.4 test").toString("base64") });
      expect(reportAttachment(path.join(dir, "run-42.html"))).toBeNull();
      expect(reportAttachment(path.join(dir, "missing.pdf"))).toBeNull();
      expect(reportAttachment(null)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("inbound email route", () => {
  let handle: DbHandle;
  const added: AuditJobData[] = [];
  const reply = vi.fn(async () => ({ messageId: "r1", threadId: "t1" }));
  const queue = { add: async (_name: string, data: AuditJobData) => (added.push(data), { id: String(added.length) }) } as unknown as Queue<AuditJobData>;
  const app = () =>
    createApp({
      db: handle.db,
      getQueue: () => queue,
      token: "test-token",
      inbound: { secret: SECRET, allowedSenders: ["ops@example.com"], reply },
    });

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
  });
  afterAll(() => handle.close());

  it("needs no bearer token but a valid signature", async () => {
    expect((await app().request(INBOUND_PATH, { method: "POST", body: "{}" })).status).toBe(400);
    const bad = signedRequest(received(), { secret: "whsec_b3RoZXI=" });
    expect((await app().request(INBOUND_PATH, bad)).status).toBe(400);
    const noSecret = createApp({ db: handle.db, getQueue: () => queue, token: "t", inbound: { allowedSenders: [], reply } });
    expect((await noSecret.request(INBOUND_PATH, signedRequest(received()))).status).toBe(503);
  });

  it("queues an audit when an alert recipient asks for one, and replies in the thread", async () => {
    added.length = 0;
    reply.mockClear();
    const res = await app().request(INBOUND_PATH, signedRequest(received()));
    expect(res.status).toBe(204);
    expect(added).toEqual([{ trigger: "manual", demo: false, tenantId: LOCAL_TENANT_ID }]);
    expect(reply).toHaveBeenCalledWith("<abc@agentmail.to>", expect.stringContaining("queued"));

    const demo = await app().request(INBOUND_PATH, signedRequest(received({ subject: "run the demo audit please" })));
    expect(demo.status).toBe(204);
    expect(added[1]).toEqual({ trigger: "manual", demo: true, tenantId: LOCAL_TENANT_ID });
  });

  it("acknowledges but ignores other mail, other senders and other events", async () => {
    added.length = 0;
    reply.mockClear();
    for (const body of [
      received({ subject: "Thanks for the report", text: "great stuff" }),
      received({ from_: ["stranger@example.net"] }),
      { event_type: "message.sent", event_id: "evt_2", message: received().message },
    ]) {
      expect((await app().request(INBOUND_PATH, signedRequest(body))).status).toBe(204);
    }
    expect(added).toEqual([]);
    expect(reply).not.toHaveBeenCalled();
  });

  it("rejects a payload that is not an AgentMail event", async () => {
    const res = await app().request(INBOUND_PATH, signedRequest({ event_type: "message.received", message: { subject: 1 } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unexpected payload");
  });
});
