import { NextResponse } from "next/server";
import { z } from "zod";
import { forward } from "@/lib/digest";

const TokenBody = z.object({ token: z.string().min(16).max(128) });

/** Stops the weekly digest for the address the emailed token belongs to. */
export async function POST(req: Request) {
  const body = TokenBody.safeParse(await req.json().catch(() => undefined));
  if (!body.success) return NextResponse.json({ error: "This link is invalid." }, { status: 400 });
  return forward("/subscribers/unsubscribe", body.data);
}
