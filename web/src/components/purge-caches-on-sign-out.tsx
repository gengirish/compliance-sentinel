"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef } from "react";

const CACHE_PREFIX = "sentinel-";

/** Deletes this app's Cache Storage entries and asks the service worker to do the same. */
async function purgeCaches() {
  try {
    if ("caches" in window) {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => caches.delete(n)));
    }
  } catch {
    // Cache Storage can be unavailable (private mode, blocked storage); nothing to purge then.
  }
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_CACHES" });
  } catch {
    // No worker, nothing cached by it.
  }
}

/**
 * Clears cached pages and assets when the user signs out, so nothing from their
 * session stays on a shared machine. Must be rendered inside ClerkProvider.
 */
export function PurgeCachesOnSignOut() {
  const { isLoaded, isSignedIn } = useAuth();
  const wasSignedIn = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    if (!isLoaded) return;
    if (wasSignedIn.current === true && !isSignedIn) void purgeCaches();
    wasSignedIn.current = isSignedIn;
  }, [isLoaded, isSignedIn]);

  return null;
}
