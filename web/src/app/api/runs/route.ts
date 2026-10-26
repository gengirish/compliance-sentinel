import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, api, apiFetch } from "@/lib/api";
import { unauthorized } from "@/lib/auth";

/** The only input this route accepts. Unknown keys are rejected so a typo does not silently run a real audit. */
const TriggerRunBody = z.strictObject({ demo: z.boolean().default(false) });

/** Queues an audit on the Sentinel API. `{ demo: true }` runs the bundled demo rules. */
export async function POST(req: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const text = await req.text();
  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "request body is not valid JSON" }, { status: 400 });
    }
  }
  const body = TriggerRunBody.safeParse(json);
  if (!body.success) {
    const issues = body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return NextResponse.json({ error: "invalid request", issues }, { status: 400 });
  }
  const { demo } = body.data;
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

/** Id and status of recent runs. Pages poll this while a run is in progress and re-render only on a change. */
export async function GET() {
  const denied = await unauthorized();
  if (denied) return denied;
  try {
    return NextResponse.json({ runs: await api.runStatuses() }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: err instanceof ApiError && err.status ? err.status : 502 });
  }
}
