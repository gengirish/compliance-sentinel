"use client";

import { useState } from "react";
import { Loader2, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

type State = { kind: "idle" } | { kind: "pending" } | { kind: "sent"; email: string } | { kind: "error"; message: string };

/** Email sign-up for the weekly digest. Shows the same confirmation for any address, as the API does. */
export function DigestSignup() {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    setState({ kind: "pending" });
    try {
      const res = await fetch("/api/digest/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, company: form.get("company") ?? "" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(res.status === 400 ? "Enter a valid email address." : (body.error ?? `Request failed (${res.status})`));
      }
      setState({ kind: "sent", email });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  }

  if (state.kind === "sent") {
    return (
      <p role="status" className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm">
        <MailCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        <span>
          Check <strong className="font-medium">{state.email}</strong> for a confirmation link. The digest starts once
          you click it.
        </span>
      </p>
    );
  }

  const pending = state.kind === "pending";
  return (
    <form onSubmit={submit} className="relative w-full max-w-md">
      <div className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor="digest-email" className="sr-only">
          Email address
        </label>
        <input
          id="digest-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
          disabled={pending}
          aria-invalid={state.kind === "error" || undefined}
          aria-describedby={state.kind === "error" ? "digest-error" : undefined}
          className="min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3.5 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
        />
        {/* Honeypot: off-screen and skipped by keyboard and screen readers, so only bots fill it. */}
        <input name="company" type="text" tabIndex={-1} autoComplete="off" aria-hidden className="absolute -left-[9999px] size-px opacity-0" />
        <Button type="submit" disabled={pending} className="shrink-0">
          {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          Subscribe
        </Button>
      </div>
      {state.kind === "error" && (
        <p id="digest-error" role="alert" className="mt-2 text-sm text-danger">
          {state.message}
        </p>
      )}
      <p className="mt-2 text-xs text-muted">One email a week. Unsubscribe from any digest with one click.</p>
    </form>
  );
}
