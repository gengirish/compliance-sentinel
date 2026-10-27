"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type State = { kind: "idle" } | { kind: "pending" } | { kind: "done"; email: string } | { kind: "error"; message: string };

export function UnsubscribeButton({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function unsubscribe() {
    setState({ kind: "pending" });
    try {
      const res = await fetch("/api/digest/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json().catch(() => ({}))) as { email?: string; error?: string };
      if (!res.ok || !body.email) {
        throw new Error(res.status === 404 || res.status === 400 ? "This link is invalid." : (body.error ?? `Request failed (${res.status})`));
      }
      setState({ kind: "done", email: body.email });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  }

  if (state.kind === "done") {
    return (
      <p role="status">
        <strong className="font-medium text-foreground">{state.email}</strong> will get no more digests. You can sign up again
        from the home page at any time.
      </p>
    );
  }
  return (
    <>
      <p>Stop sending the weekly regulatory digest to this address?</p>
      <Button type="button" onClick={() => void unsubscribe()} disabled={state.kind === "pending"}>
        {state.kind === "pending" && <Loader2 className="size-4 animate-spin" aria-hidden />}
        Unsubscribe
      </Button>
      {state.kind === "error" && (
        <p role="alert" className="text-danger">
          {state.message}
        </p>
      )}
    </>
  );
}
