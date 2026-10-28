import { NextResponse } from "next/server";
import { z } from "zod";
import { unauthorized } from "@/lib/auth";
import { forward } from "@/lib/digest";

// Like the preview, a test send renders the digest first, which can wait on Claude.
export const maxDuration = 120;

const TestBody = z.strictObject({ email: z.email().max(254), days: z.int().min(1).max(90).optional() });

/** Emails this week's digest to one address only, so the operator can check it in a real inbox. */
export async function POST(req: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const body = TestBody.safeParse(await req.json().catch(() => undefined));
  if (!body.success) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  return forward("/digest/test", body.data, { timeoutMs: 120_000 });
}
