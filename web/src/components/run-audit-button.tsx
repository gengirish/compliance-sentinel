"use client";

import { useEffect, useId, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { useReloadOnRunChange } from "@/components/refresh-while";
import { Button } from "@/components/ui/button";

type Result = { tone: "ok" | "error"; text: string } | null;
type LatestRun = { id: number; status: string } | null;

/** How long to keep polling for a queued audit that the worker has not started. */
const QUEUE_WAIT_MS = 2 * 60 * 1000;

/**
 * `latestRun` is the newest run the page rendered. While it is in progress, and after a
 * trigger until the new run appears, the page polls and reloads itself when the run
 * starts or finishes, so the list never needs a manual reload.
 */
export function RunAuditButton({ latestRun = null }: { latestRun?: LatestRun }) {
  const [demo, setDemo] = useState(true);
  const [repoUrl, setRepoUrl] = useState("");
  const demoHelpId = useId();
  const repoInputId = useId();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result>(null);
  // Set by a trigger until the new run shows up (the page reloads then).
  const [waiting, setWaiting] = useState(false);
  const running = latestRun?.status === "running";
  // A second trigger while one is queued or running would only queue a duplicate audit.
  const busy = pending || waiting || running;

  useReloadOnRunChange(running || waiting, (runs) => {
    const newest = runs[0];
    return newest !== undefined && (newest.id !== latestRun?.id || newest.status !== latestRun?.status);
  });

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setWaiting(false);
      setResult({ tone: "error", text: "The worker has not started the audit yet. Check that it is running." });
    }, QUEUE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  async function trigger() {
    setResult(null);
    setPending(true);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ demo, ...(repoUrl.trim() && { repoUrl: repoUrl.trim() }) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: { message: string }[] };
      if (res.ok) {
        // No job id: it is a queue id, not the run number, and users went looking for a run by it.
        setResult({ tone: "ok", text: "Audit queued. It appears under Runs as soon as the worker starts it." });
        setWaiting(true);
      } else {
        // A rejected repository URL comes back as a validation issue; its message says what is accepted.
        setResult({ tone: "error", text: body.issues?.[0]?.message ?? body.error ?? `Request failed (${res.status})` });
      }
    } catch (err) {
      setResult({ tone: "error", text: `Request failed (${(err as Error).message})` });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex w-full flex-col gap-1 sm:w-96">
        <label htmlFor={repoInputId} className="text-sm text-muted">
          Repository <span className="text-xs">(optional)</span>
        </label>
        <input
          id={repoInputId}
          type="url"
          inputMode="url"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) void trigger();
          }}
          placeholder="https://github.com/owner/name"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
        />
        <p className="text-xs text-muted">Any public GitHub, GitLab, Codeberg or Bitbucket repo. Blank audits the configured target.</p>
      </div>
      <div className="flex items-center gap-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={demo}
            onChange={(e) => setDemo(e.target.checked)}
            aria-describedby={demoHelpId}
            className="size-4 accent-primary"
          />
          Demo rules
        </label>
        <Button onClick={() => void trigger()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
          {busy ? "Audit running…" : "Run audit"}
        </Button>
      </div>
      <p id={demoHelpId} className="text-xs text-muted">
        {demo
          ? "Demo rules: audits against the sample regulations bundled with Sentinel, all re-checked."
          : "Live: scrapes the enabled regulator sources and audits only new or changed rules."}
      </p>
      <p role="status" aria-live="polite" className={result?.tone === "error" ? "text-sm text-danger" : "text-sm text-success"}>
        {result?.text}
      </p>
    </div>
  );
}
