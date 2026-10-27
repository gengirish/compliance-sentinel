import { NextResponse } from "next/server";
import { z } from "zod";
import { forward } from "@/lib/digest";

// `company` is a honeypot: hidden from people, so a value means a bot filled the form.
const SubscribeBody = z.object({ email: z.email().max(254), company: z.string().optional() });

/** Public sign-up for the weekly digest. The API emails a confirmation link; nothing is sent until it is clicked. */
export async function POST(req: Request) {
  const body = SubscribeBody.safeParse(await req.json().catch(() => undefined));
  if (!body.success) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  // Answer a bot as if it worked, so it has no reason to try again.
  if (body.data.company) return NextResponse.json({ ok: true }, { status: 202 });
  return forward("/subscribers", { email: body.data.email });
}
