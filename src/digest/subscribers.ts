import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { digestSubscribers } from "../db/schema.js";

/**
 * Weekly digest subscriptions from the website. Double opt-in: signing up stores a pending
 * row and emails a confirmation link; only that link makes the address active. Each row's
 * token confirms and unsubscribes, so neither needs a sign-in.
 */

/** A pending address is not sent another confirmation inside this window, so the form cannot be used to flood an inbox. */
export const CONFIRMATION_COOLDOWN_MS = 10 * 60 * 1000;

export type Subscriber = { email: string; token: string };

export type SubscribeOutcome =
  /** A confirmation email should go to this address now. */
  | { kind: "confirm"; subscriber: Subscriber }
  /** Nothing to send: already active, or a confirmation went out moments ago. */
  | { kind: "noop" };

const newToken = () => randomBytes(24).toString("base64url");

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function confirmUrl(token: string, base = config.DASHBOARD_URL): string {
  return `${base.replace(/\/+$/, "")}/subscribe/confirm?token=${encodeURIComponent(token)}`;
}

export function unsubscribeUrl(token: string, base = config.DASHBOARD_URL): string {
  return `${base.replace(/\/+$/, "")}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Records a sign-up. A new or previously unsubscribed address becomes pending with a fresh
 * token; a pending one keeps its token and is re-sent the link once the cooldown has passed.
 */
export async function subscribe(db: Db, rawEmail: string, now = new Date()): Promise<SubscribeOutcome> {
  const email = normalizeEmail(rawEmail);
  const [existing] = await db.select().from(digestSubscribers).where(eq(digestSubscribers.email, email));

  if (!existing) {
    const token = newToken();
    await db.insert(digestSubscribers).values({ email, token, confirmationSentAt: now }).onConflictDoNothing();
    // A concurrent sign-up for the same address may have won the insert; its email covers this one.
    const [row] = await db.select().from(digestSubscribers).where(eq(digestSubscribers.email, email));
    return row?.token === token ? { kind: "confirm", subscriber: { email, token } } : { kind: "noop" };
  }
  if (existing.status === "active") return { kind: "noop" };

  if (existing.status === "unsubscribed") {
    const token = newToken();
    await db
      .update(digestSubscribers)
      .set({ status: "pending", token, confirmationSentAt: now, unsubscribedAt: null })
      .where(eq(digestSubscribers.id, existing.id));
    return { kind: "confirm", subscriber: { email, token } };
  }

  const sentAt = existing.confirmationSentAt?.getTime() ?? 0;
  if (now.getTime() - sentAt < CONFIRMATION_COOLDOWN_MS) return { kind: "noop" };
  await db.update(digestSubscribers).set({ confirmationSentAt: now }).where(eq(digestSubscribers.id, existing.id));
  return { kind: "confirm", subscriber: { email, token: existing.token } };
}

/** Activates the subscription the token belongs to. Returns its address, or null for an unknown or unsubscribed token. */
export async function confirmSubscription(db: Db, token: string): Promise<string | null> {
  const [row] = await db.select().from(digestSubscribers).where(eq(digestSubscribers.token, token));
  if (!row || row.status === "unsubscribed") return null;
  if (row.status === "pending") {
    await db
      .update(digestSubscribers)
      .set({ status: "active", confirmedAt: sql`now()` })
      .where(and(eq(digestSubscribers.id, row.id), eq(digestSubscribers.status, "pending")));
  }
  return row.email;
}

/** Stops the digest for the token's address. Returns the address, or null for an unknown token. Repeating it is harmless. */
export async function unsubscribe(db: Db, token: string): Promise<string | null> {
  const [row] = await db.select().from(digestSubscribers).where(eq(digestSubscribers.token, token));
  if (!row) return null;
  if (row.status !== "unsubscribed") {
    await db
      .update(digestSubscribers)
      .set({ status: "unsubscribed", unsubscribedAt: sql`now()` })
      .where(eq(digestSubscribers.id, row.id));
  }
  return row.email;
}

export async function activeSubscribers(db: Db): Promise<Subscriber[]> {
  return db
    .select({ email: digestSubscribers.email, token: digestSubscribers.token })
    .from(digestSubscribers)
    .where(eq(digestSubscribers.status, "active"))
    .orderBy(digestSubscribers.id);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function buildConfirmationEmail(token: string, base = config.DASHBOARD_URL): { subject: string; html: string; text: string } {
  const link = confirmUrl(token, base);
  const subject = "[Compliance Sentinel] Confirm your weekly regulatory digest";
  const text = [
    "Someone, hopefully you, asked to receive the Compliance Sentinel weekly digest of regulatory rule changes at this address.",
    "",
    `Confirm the subscription: ${link}`,
    "",
    "If it was not you, ignore this email and nothing more will be sent.",
  ].join("\n");
  const html = `<p>Someone, hopefully you, asked to receive the Compliance Sentinel weekly digest of regulatory rule changes at this address.</p>
<p><a href="${escapeHtml(link)}">Confirm the subscription</a></p>
<p style="color:#6b7280;font-size:12px">If it was not you, ignore this email and nothing more will be sent.</p>`;
  return { subject, html, text };
}
