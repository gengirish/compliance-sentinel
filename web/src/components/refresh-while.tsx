"use client";

import { useEffect, useRef } from "react";

export const POLL_INTERVAL_MS = 4_000;

export type RunStatus = { id: number; status: string };

/**
 * While `active`, polls /api/runs (id and status only) and reloads the page only
 * when `changed` says what it rendered is out of date: a run started or finished.
 *
 * It reloads rather than calling router.refresh(). On Next 16.1.6, refreshes after
 * the first on a page were often fetched but never committed, so the page sat on a
 * finished run (reproduced with no polling code involved). Changes are rare, so a
 * reload on change costs little, and polling a small JSON route is far cheaper than
 * re-rendering the page on every tick.
 */
export function useReloadOnRunChange(active: boolean, changed: (runs: RunStatus[]) => boolean) {
  // Latest callback without restarting the poll each render.
  const changedRef = useRef(changed);
  useEffect(() => {
    changedRef.current = changed;
  });

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/runs", { cache: "no-store" });
        if (!res.ok || stopped) return;
        const { runs } = (await res.json()) as { runs: RunStatus[] };
        if (!stopped && changedRef.current(runs)) {
          stopped = true;
          window.location.reload();
        }
      } catch {
        // A missed tick is harmless; the next one retries.
      }
    };
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active]);
}

/** For a run's own page: keeps it current until the run finishes. */
export function RefreshWhileRunning({ runId, status }: { runId: number; status: string }) {
  useReloadOnRunChange(status === "running", (runs) => {
    const latest = runs.find((r) => r.id === runId);
    return latest !== undefined && latest.status !== status;
  });
  return null;
}
