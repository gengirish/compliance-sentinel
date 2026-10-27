"use client";

import { useEffect, useRef } from "react";

export const POLL_INTERVAL_MS = 4_000;

export type RunStatus = { id: number; status: string };

type SavedView = { scrollY: number; open: number[] };

/** One saved view per page (path and query), so a reload elsewhere never restores into it. */
function viewKey() {
  return `reload-view:${window.location.pathname}${window.location.search}`;
}

/** Remembers the scroll position and which <details> are open, then reloads. */
function reloadKeepingView() {
  try {
    const open = [...document.querySelectorAll("details")].flatMap((d, i) => (d.open ? [i] : []));
    sessionStorage.setItem(viewKey(), JSON.stringify({ scrollY: window.scrollY, open } satisfies SavedView));
  } catch {
    // Storage can be blocked; the reload still has to happen.
  }
  window.location.reload();
}

/** Puts back what reloadKeepingView saved, once, and forgets it. */
function restoreView() {
  try {
    const key = viewKey();
    const raw = sessionStorage.getItem(key);
    if (raw === null) return;
    sessionStorage.removeItem(key);
    const { scrollY, open } = JSON.parse(raw) as SavedView;
    const details = document.querySelectorAll("details");
    for (const i of open) {
      const d = details[i];
      if (d) d.open = true;
    }
    // After the details have opened, so the page is tall enough to scroll that far.
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  } catch {
    // A bad or unreadable entry just means the page starts at the top.
  }
}

/**
 * While `active`, polls /api/runs (id and status only) and reloads the page only
 * when `changed` says what it rendered is out of date: a run started or finished.
 *
 * It reloads rather than calling router.refresh(). On Next 16.1.6, refreshes after
 * the first on a page were often fetched but never committed, so the page sat on a
 * finished run (reproduced with no polling code involved). Changes are rare, so a
 * reload on change costs little, and polling a small JSON route is far cheaper than
 * re-rendering the page on every tick. The scroll position and open <details> are
 * kept across the reload and put back on the next mount.
 */
export function useReloadOnRunChange(active: boolean, changed: (runs: RunStatus[]) => boolean) {
  // Latest callback without restarting the poll each render.
  const changedRef = useRef(changed);
  useEffect(() => {
    changedRef.current = changed;
  });

  useEffect(() => {
    restoreView();
  }, []);

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
          reloadKeepingView();
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
