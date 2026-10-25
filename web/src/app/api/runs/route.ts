import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";
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
