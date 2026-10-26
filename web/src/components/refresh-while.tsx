"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export const REFRESH_INTERVAL_MS = 4_000;

/** Re-renders the current server components every few seconds while `active` holds. */
export function useRefreshWhile(active: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, router]);
}

/** For server-rendered pages that show a run: keeps it current until it finishes. */
export function RefreshWhile({ active }: { active: boolean }) {
  useRefreshWhile(active);
  return null;
}
