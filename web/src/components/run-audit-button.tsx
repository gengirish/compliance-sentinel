"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";
import { useRefreshWhile } from "@/components/refresh-while";
import { Button } from "@/components/ui/button";

type Result = { tone: "ok" | "error"; text: string } | null;
type LatestRun = { id: number; status: string } | null;

/** How long to keep polling for a queued audit that the worker has not started. */
const QUEUE_WAIT_MS = 2 * 60 * 1000;

/**
 * `latestRun` is the newest run the page rendered. After a trigger the page polls
 * until a newer run appears and finishes, and it also polls while any run is in progress,
 * so the list never needs a manual reload.
 */
export function RunAuditButton({ latestRun = null }: { latestRun?: LatestRun }) {
  const router = useRouter();
  const [demo, setDemo] = useState(true);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Result>(null);
  // The newest run id at the moment of the trigger, and when the trigger happened.
  const [waiting, setWaiting] = useState<{ afterId: number; since: number } | null>(null);

  const running = latestRun?.status === "running";
  const started = waiting !== null && latestRun !== null && latestRun.id > waiting.afterId;
  // Once the triggered run finishes its row tells the story, so the banner goes.
  const finished = started && !running;
  useRefreshWhile(running || (waiting !== null && !started));

  useEffect(() => {
    if (!waiting || started) return;
    const timer = setTimeout(
      () => {
        setWaiting(null);
        setResult({ tone: "error", text: "The worker has not started the audit yet. Check that it is running." });
      },
      QUEUE_WAIT_MS - (Date.now() - waiting.since),
    );
    return () => clearTimeout(timer);
  }, [waiting, started]);

  function trigger() {
    setResult(null);
    startTransition(async () => {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ demo }),
      });
      const body = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (res.ok) {
        setResult({ tone: "ok", text: `Audit queued (job ${body.jobId}). It appears under Runs once the worker picks it up.` });
        setWaiting({ afterId: latestRun?.id ?? 0, since: Date.now() });
        router.refresh();
      } else {
        setResult({ tone: "error", text: body.error ?? `Request failed (${res.status})` });
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={demo}
            onChange={(e) => setDemo(e.target.checked)}
            className="size-4 accent-primary"
          />
          Demo rules
        </label>
        <Button onClick={trigger} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
          Run audit
        </Button>
      </div>
      <p role="status" aria-live="polite" className={result?.tone === "error" ? "text-sm text-danger" : "text-sm text-success"}>
        {finished ? null : result?.text}
      </p>
    </div>
  );
}
