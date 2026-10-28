import { NextResponse } from "next/server";
import { z } from "zod";
import { unauthorized } from "@/lib/auth";
import { forward } from "@/lib/digest";

const SendBody = z.strictObject({});

/** Queues the digest for everyone now: the team, every active subscriber and Slack. The API answers 202 with a job id. */
export async function POST(req: Request) {
  const denied = await unauthorized();
  if (denied) return denied;
  const body = SendBody.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "expected an empty body" }, { status: 400 });
  return forward("/digest/send", {});
}
