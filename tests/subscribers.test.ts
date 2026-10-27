/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed JSON responses */
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { deliverDigest, type DigestReport } from "../src/digest/deliver.js";
import {
  activeSubscribers,
  CONFIRMATION_COOLDOWN_MS,
  confirmSubscription,
  subscribe,
  unsubscribe,
} from "../src/digest/subscribers.js";
import { AgentMailClient } from "../src/notify/agentmail.js";
import type { AuditJobData } from "../src/queue/queue.js";
import { createApp } from "../src/web/server.js";

const auth = { authorization: "Bearer t", "content-type": "application/json" };

describe("digest subscriptions", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
  });
  afterAll(() => handle.close());

  it("is double opt-in: pending until the emailed token confirms it", async () => {
    const now = new Date("2026-10-27T10:00:00Z");
    const first = await subscribe(handle.db, "  Ana@Example.com ", now);
    expect(first).toMatchObject({ kind: "confirm", subscriber: { email: "ana@example.com" } });
    expect(await activeSubscribers(handle.db)).toEqual([]);

    // Inside the cooldown a repeat sign-up sends nothing; after it, the same link again.
    expect(await subscribe(handle.db, "ana@example.com", new Date(now.getTime() + 60_000))).toEqual({ kind: "noop" });
    const later = await subscribe(handle.db, "ana@example.com", new Date(now.getTime() + CONFIRMATION_COOLDOWN_MS + 1));
    expect(later).toEqual(first);

    const token = (first as { subscriber: { token: string } }).subscriber.token;
    expect(await confirmSubscription(handle.db, token)).toBe("ana@example.com");
    expect(await confirmSubscription(handle.db, token)).toBe("ana@example.com");
    expect(await activeSubscribers(handle.db)).toEqual([{ email: "ana@example.com", token }]);
    expect(await subscribe(handle.db, "ana@example.com")).toEqual({ kind: "noop" });
  });

  it("unsubscribes by token, and a new sign-up issues a fresh token", async () => {
    const { token } = (await activeSubscribers(handle.db))[0]!;
    expect(await unsubscribe(handle.db, token)).toBe("ana@example.com");
    expect(await unsubscribe(handle.db, token)).toBe("ana@example.com");
    expect(await activeSubscribers(handle.db)).toEqual([]);
    expect(await confirmSubscription(handle.db, token)).toBeNull();
    expect(await unsubscribe(handle.db, "no-such-token-at-all")).toBeNull();

    const again = await subscribe(handle.db, "ana@example.com");
    expect(again.kind).toBe("confirm");
    expect((again as { subscriber: { token: string } }).subscriber.token).not.toBe(token);
  });

  describe("API", () => {
    const sendMail = vi.fn(async () => ({}));
    const app = () =>
      createApp({ db: handle.db, getQueue: () => ({}) as Queue<AuditJobData>, token: "t", sendMail });
    const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
      app().request(path, { method: "POST", headers, body: JSON.stringify(body) });

    it("needs the token and a valid address", async () => {
      expect((await post("/subscribers", { email: "x@example.com" }, { "content-type": "application/json" })).status).toBe(401);
      const bad = await post("/subscribers", { email: "not-an-email" });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as any).issues[0].path).toBe("email");
    });

    it("emails a confirmation link, then confirms and unsubscribes through it", async () => {
      sendMail.mockClear();
      const res = await post("/subscribers", { email: "bo@example.com" });
      expect(res.status).toBe(202);
      expect(sendMail).toHaveBeenCalledOnce();
      const message = (sendMail.mock.calls[0] as unknown as [{ to: string[]; text: string }])[0];
      expect(message.to).toEqual(["bo@example.com"]);
      const token = new URL(/https?:\/\/\S+/.exec(message.text)![0]).searchParams.get("token")!;
      expect(message.text).toContain("/subscribe/confirm?token=");

      // Same answer for an address that is already pending, and no second email.
      expect((await post("/subscribers", { email: "bo@example.com" })).status).toBe(202);
      expect(sendMail).toHaveBeenCalledOnce();

      const confirmed = await post("/subscribers/confirm", { token });
      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toEqual({ email: "bo@example.com" });
      expect((await post("/subscribers/unsubscribe", { token })).status).toBe(200);
      expect((await post("/subscribers/confirm", { token })).status).toBe(404);
      expect((await post("/subscribers/unsubscribe", { token: "x".repeat(32) })).status).toBe(404);
    });

    it("refuses sign-ups when email is not configured", async () => {
      const noMail = createApp({ db: handle.db, getQueue: () => ({}) as Queue<AuditJobData>, token: "t" });
      const res = await noMail.request("/subscribers", { method: "POST", headers: auth, body: JSON.stringify({ email: "c@example.com" }) });
      expect(res.status).toBe(503);
    });
  });

  it("sends each subscriber their own copy with an unsubscribe link", async () => {
    const sent: { to: string[]; text: string; html: string }[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ message_id: "m", thread_id: "t" }), { status: 200 });
    }) as unknown as typeof fetch;
    const mail = new AgentMailClient({ apiKey: "k", inboxId: "inbox", baseUrl: "https://mail.test", fetchImpl });
    const report: DigestReport = { from: "2026-10-20", to: "2026-10-27", records: [], costUsd: 0 };

    const delivered = await deliverDigest(report, {
      mail,
      fetchImpl,
      subscribers: [
        { email: "one@example.com", token: "tok-one" },
        { email: "two@example.com", token: "tok-two" },
      ],
    });

    expect(delivered).toContain("subscribers");
    const personal = sent.filter((m) => m.to.length === 1 && m.to[0]!.endsWith("@example.com"));
    expect(personal.map((m) => m.to[0])).toEqual(["one@example.com", "two@example.com"]);
    expect(personal[0]!.text).toContain("/unsubscribe?token=tok-one");
    expect(personal[0]!.html).toContain("Unsubscribe</a>");
    expect(personal[1]!.text).not.toContain("tok-one");
  });
});
