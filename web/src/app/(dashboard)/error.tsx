"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const isDev = process.env.NODE_ENV === "development";
  return (
    <Card className="mx-auto max-w-xl border-danger/30">
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
        <div className="space-y-3">
          <h1 className="font-semibold">Couldn&apos;t load audit data</h1>
          {isDev ? (
            <>
              <p className="text-sm text-muted">{error.message}</p>
              <p className="text-sm text-muted">
                Check that the API is running (<code className="font-mono text-xs">pnpm dev:web</code> in the repo root) and
                that <code className="font-mono text-xs">SENTINEL_API_TOKEN</code> matches{" "}
                <code className="font-mono text-xs">RUN_TRIGGER_TOKEN</code>.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">
              We couldn&apos;t reach the audit service. Try again in a moment, and if this keeps
              happening, contact your administrator{error.digest ? ` (reference ${error.digest})` : ""}.
            </p>
          )}
          <Button variant="secondary" size="sm" onClick={reset}>
            Retry
          </Button>
        </div>
      </div>
    </Card>
  );
}
