"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

type Result = { tone: "ok" | "error"; text: string } | null;

export function RunAuditButton() {
  const router = useRouter();
  const [demo, setDemo] = useState(true);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Result>(null);

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
        {result?.text}
      </p>
    </div>
  );
}
