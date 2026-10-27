import "server-only";
import { NextResponse } from "next/server";
import { ApiError, apiFetch } from "@/lib/api";

/**
 * Weekly digest subscriptions. These routes are public, since visitors are not signed in, so
 * they only validate input and forward it; the API holds the double opt-in logic.
 */

export type SubscriptionResult = { ok: true; email: string } | { ok: false; error: string };

/** POSTs a JSON body to the API and relays its answer as this app's response. */
export async function forward(path: string, body: unknown): Promise<NextResponse> {
  try {
    const res = await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: err instanceof ApiError && err.status ? err.status : 502 });
  }
}

/** Confirms or cancels a subscription by its emailed token, for the server-rendered confirm page. */
export async function useToken(action: "confirm" | "unsubscribe", token: string): Promise<SubscriptionResult> {
  try {
    const res = await apiFetch(`/subscribers/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = (await res.json().catch(() => ({}))) as { email?: string; error?: string };
    if (res.ok && body.email) return { ok: true, email: body.email };
    return { ok: false, error: res.status === 404 || res.status === 400 ? "This link is invalid or has expired." : (body.error ?? `Request failed (${res.status})`) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
