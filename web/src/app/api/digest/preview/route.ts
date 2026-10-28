import { NextResponse } from "next/server";
import { z } from "zod";
import { unauthorized } from "@/lib/auth";
import { forward } from "@/lib/digest";

// Rendering a preview can wait on Claude summarising rules that are new since the last digest.
export const maxDuration = 120;

const PreviewBody = z.strictObject({ days: z.int().min(1).max(90).optional() });

/** Renders this week's digest without sending it, for the operator's settings page. */
export async function POST(req: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const body = PreviewBody.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "expected { days?: 1-90 }" }, { status: 400 });
  return forward("/digest/preview", body.data, { timeoutMs: 120_000 });
}
