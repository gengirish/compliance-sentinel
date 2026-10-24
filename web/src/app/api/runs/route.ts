import { NextResponse } from "next/server";
import { ApiError, apiFetch } from "@/lib/api";
import { unauthorized } from "@/lib/auth";

/** Queues an audit on the Sentinel API. `{ demo: true }` runs the bundled demo rules. */
export async function POST(req: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const { demo } = (await req.json().catch(() => ({}))) as { demo?: boolean };
  try {
    const res = await apiFetch(`/runs${demo ? "?demo=1" : ""}`, { method: "POST", timeoutMs: 8_000 });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    const message =
      err instanceof ApiError && /timeout|aborted/i.test(err.message)
        ? "The API accepted the request but could not reach the queue. Is Redis running?"
        : (err as Error).message;
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
