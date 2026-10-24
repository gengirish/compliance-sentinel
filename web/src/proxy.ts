import { NextResponse } from "next/server";
import { clerkMiddleware } from "@clerk/nextjs/server";

// Clerk's middleware only attaches the session. Each layout and route handler checks it
// itself (src/lib/auth.ts). E2E runs swap in a pass-through, because Playwright cannot
// drive Clerk's hosted UI.
export default process.env.E2E_BYPASS_CLERK === "1" ? () => NextResponse.next() : clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
