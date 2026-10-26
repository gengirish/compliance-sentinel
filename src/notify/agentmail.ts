import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";

/**
 * A thin client for the AgentMail REST API (https://docs.agentmail.to): the
 * app owns an inbox there, sends alerts from it, and receives mail sent to it
 * through a signed webhook. No SDK, so the dependency list stays the same.
 */

export type Attachment = {
  filename: string;
  content_type?: string;
  /** Base64 file data. The whole request is limited to 6 MB. */
  content: string;
};

export type OutgoingMessage = {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: Attachment[];
};

export type SentMessage = { messageId: string; threadId: string };

export type AgentMailClientOptions = {
  apiKey?: string;
  inboxId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class AgentMailClient {
  readonly inboxId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; inboxId: string; baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.inboxId = opts.inboxId;
    this.baseUrl = (opts.baseUrl ?? config.AGENTMAIL_API_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The client for the configured inbox, or null when AgentMail is not configured (dry-run mode). */
  static fromConfig(overrides: AgentMailClientOptions = {}): AgentMailClient | null {
    const apiKey = overrides.apiKey ?? config.AGENTMAIL_API_KEY;
    const inboxId = overrides.inboxId ?? config.AGENTMAIL_INBOX_ID;
    if (!apiKey || !inboxId) return null;
    return new AgentMailClient({ apiKey, inboxId, baseUrl: overrides.baseUrl, fetchImpl: overrides.fetchImpl });
  }

  send(message: OutgoingMessage): Promise<SentMessage> {
    return this.post(`/inboxes/${encodeURIComponent(this.inboxId)}/messages/send`, message);
  }

  /** Replies in the thread of a received message. */
  reply(messageId: string, body: { text: string; html?: string }): Promise<SentMessage> {
    return this.post(
      `/inboxes/${encodeURIComponent(this.inboxId)}/messages/${encodeURIComponent(messageId)}/reply`,
      body,
    );
  }

  private async post(path: string, body: unknown): Promise<SentMessage> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`AgentMail HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = (await res.json()) as { message_id?: string; thread_id?: string };
    return { messageId: data.message_id ?? "", threadId: data.thread_id ?? "" };
  }
}

// ---- Inbound webhook -------------------------------------------------------------

const addresses = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]));

/** A received message as delivered by a `message.received` webhook event. */
export const InboundMessage = z
  .object({
    inbox_id: z.string(),
    message_id: z.string(),
    thread_id: z.string().optional(),
    from_: addresses,
    from: addresses,
    to: addresses,
    subject: z.string().default(""),
    text: z.string().optional(),
    preview: z.string().optional(),
  })
  .transform((m) => ({ ...m, from: m.from_.length ? m.from_ : m.from }));

export const WebhookEvent = z.object({
  event_type: z.string(),
  event_id: z.string().optional(),
  message: InboundMessage.optional(),
});
export type WebhookEventType = z.infer<typeof WebhookEvent>;

export type WebhookHeaders = { id?: string; timestamp?: string; signature?: string };

/** Five minutes, the Svix default. */
const TOLERANCE_MS = 5 * 60 * 1000;

function signingKey(secret: string): Buffer {
  return Buffer.from(secret.replace(/^whsec_/, ""), "base64");
}

/** The `v1,<base64>` signature Svix computes over `id.timestamp.body`. Exported so tests and tools can sign. */
export function signWebhook(body: string, headers: { id: string; timestamp: string }, secret: string): string {
  const mac = createHmac("sha256", signingKey(secret)).update(`${headers.id}.${headers.timestamp}.${body}`).digest("base64");
  return `v1,${mac}`;
}

/**
 * Verifies a Svix-signed delivery (AgentMail uses Svix): the signature must be
 * over the raw body and the timestamp within tolerance. Space-separated
 * signatures are tried in turn, so a secret rotation does not drop events.
 */
export function verifyWebhookSignature(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
  now: number = Date.now(),
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts * 1000) > TOLERANCE_MS) return false;
  const expected = Buffer.from(signWebhook(rawBody, { id: headers.id, timestamp: headers.timestamp }, secret));
  return headers.signature.split(/\s+/).some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** "Jane Doe <jane@example.com>" -> "jane@example.com", lower-cased. */
export function senderAddress(from: string[]): string | null {
  const first = from[0];
  if (!first) return null;
  const match = first.match(/<([^>]+)>/);
  return (match?.[1] ?? first).trim().toLowerCase() || null;
}

export type InboundCommand = { kind: "audit"; demo: boolean };

/**
 * The one command the inbox understands: an email asking to run an audit
 * ("run audit", "please trigger the audit", "audit now"). "demo" anywhere in
 * the subject or opening lines audits the bundled demo rules instead.
 */
export function parseInboundCommand(subject: string, text: string | undefined): InboundCommand | null {
  const haystack = `${subject}\n${(text ?? "").slice(0, 600)}`;
  const asksForAudit =
    /\b(run|start|trigger|kick\s*off|launch)\b[^.\n]{0,40}\baudit\b/i.test(haystack) || /\baudit\s+now\b/i.test(haystack);
  if (!asksForAudit) return null;
  return { kind: "audit", demo: /\bdemo\b/i.test(haystack) };
}
