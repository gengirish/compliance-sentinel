import "server-only";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const bypass = () => process.env.E2E_BYPASS_CLERK === "1";

/** For pages and layouts: sends a signed-out visitor to the sign-in page. */
export async function requireUser(): Promise<void> {
  if (bypass()) return;
  const { userId, redirectToSignIn } = await auth();
  if (!userId) redirectToSignIn();
}

/** For route handlers: a 401 response when signed out, otherwise null. */
export async function unauthorized(): Promise<NextResponse | null> {
  if (bypass()) return null;
  const { userId } = await auth();
  return userId ? null : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
