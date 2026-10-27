"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  name: string;
  label: string;
  enabled: boolean;
  defaultEnabled: boolean;
  overridden: boolean;
};

/**
 * One scraper's on/off switch, plus a reset back to its SCRAPE_* flag when the dashboard has
 * overridden it. Saves straight away, then reloads the page to show the API's answer.
 */
export function SourceSwitch({ name, label, enabled, defaultEnabled, overridden }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown at once, so the switch does not lag the click while the page re-renders.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const on = optimistic ?? enabled;

  async function save(next: boolean | null) {
    setError(null);
    setPending(true);
    setOptimistic(next ?? defaultEnabled);
    try {
      const res = await fetch(`/api/settings/sources/${name}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      // A reload rather than router.refresh(): on Next 16.1.6 a second refresh on a page is often
      // fetched but never committed (see refresh-while.tsx), which left a row's badge one switch
      // behind. A reload keeps the URL, so the list's filters and sort survive it. The switch
      // stays pending until the page comes back.
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
      setOptimistic(null);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        {pending && <Loader2 className="size-4 animate-spin text-muted" aria-hidden />}
        {overridden && !pending && (
          <button
            type="button"
            onClick={() => void save(null)}
            // The ::before pads the hit area to 44px tall without moving the row.
            className="relative text-xs text-muted underline-offset-2 before:absolute before:-inset-x-2 before:-inset-y-3.5 hover:text-foreground hover:underline"
            title={`Use the environment default (${defaultEnabled ? "on" : "off"})`}
          >
            Reset
          </button>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`Scrape ${label}`}
          disabled={pending}
          onClick={() => void save(!on)}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors",
            // Same 44px hit area trick as Reset; the track itself stays 24px.
            "before:absolute before:inset-x-0 before:-inset-y-2.5",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60",
            // The off border must reach 3:1 against the card, or the track's edge is invisible.
            on ? "border-primary bg-primary" : "border-muted/70 bg-surface-light",
          )}
        >
          <span
            aria-hidden
            className={cn("inline-block size-4 rounded-full bg-white shadow transition-transform", on ? "translate-x-6" : "translate-x-1")}
          />
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
