"use client";

import { useState } from "react";
import { Eye, Loader2, Mail, Send } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = {
  emailConfigured: boolean;
  slackConfigured: boolean;
  /** Confirmed subscribers, for the send-to-everyone confirmation. */
  activeSubscribers: number;
};

type Preview = {
  from: string;
  to: string;
  rules: number;
  costUsd: number;
  errors: string[];
  subject: string;
  html: string;
  text: string;
};
type TestSent = { sentTo: string; rules: number; subject: string };
type Queued = { jobId: string };

type Action<T> = { kind: "idle" } | { kind: "pending" } | { kind: "done"; data: T } | { kind: "error"; message: string };

/** POSTs JSON to one of this app's digest routes and returns the body, or throws the API's error. */
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

/** One action's state, run independently of the others so a slow preview never blocks a send. */
function useAction<T>() {
  const [state, setState] = useState<Action<T>>({ kind: "idle" });
  async function run(path: string, body: unknown) {
    setState({ kind: "pending" });
    try {
      setState({ kind: "done", data: await post<T>(path, body) });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  }
  return [state, run] as const;
}

const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const formatDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : day.format(d);
};

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="mt-2 text-sm text-danger">
      {children}
    </p>
  );
}

/** Preview, test send and send-now for the weekly digest, on the operator's settings page. */
export function DigestControls({ emailConfigured, slackConfigured, activeSubscribers }: Props) {
  const [preview, runPreview] = useAction<Preview>();
  const [test, runTest] = useAction<TestSent>();
  const [send, runSend] = useAction<Queued>();
  const [email, setEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const canSend = emailConfigured || slackConfigured;

  return (
    <div className="mt-5 flex flex-col gap-6 border-t border-border pt-5">
      {/* Preview */}
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={preview.kind === "pending"}
            onClick={() => void runPreview("/api/digest/preview", {})}
          >
            {preview.kind === "pending" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            Preview
          </Button>
          <p className="text-sm text-muted">
            {preview.kind === "pending"
              ? "Rendering. This can take up to a minute when new rules need summarising."
              : "Renders this week's digest here. Nothing is sent."}
          </p>
        </div>
        {preview.kind === "error" && <ErrorText>{preview.message}</ErrorText>}
        {preview.kind === "done" && (
          <div className="mt-3">
            <p className="font-medium">{preview.data.subject}</p>
            <p className="mt-1 text-sm text-muted">
              {preview.data.rules} {preview.data.rules === 1 ? "rule" : "rules"}, {formatDay(preview.data.from)} to{" "}
              {formatDay(preview.data.to)}, cost ${preview.data.costUsd.toFixed(2)}. Nothing was sent.
            </p>
            {preview.data.errors.length > 0 && (
              <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
                <p className="font-medium">Some rules could not be summarised:</p>
                {preview.data.errors.map((e, i) => (
                  <p key={i} className="mt-1">
                    {e}
                  </p>
                ))}
              </div>
            )}
            {/* sandbox="" allows nothing: no scripts, forms or navigation from the rendered email. */}
            <iframe
              sandbox=""
              srcDoc={preview.data.html}
              title={`Digest preview: ${preview.data.subject}`}
              className="mt-3 h-[32rem] w-full rounded-lg border border-border bg-white"
            />
          </div>
        )}
      </div>

      {/* Test send */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runTest("/api/digest/test", { email: email.trim() });
        }}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label htmlFor="digest-test-email" className="sr-only">
            Test recipient email
          </label>
          <input
            id="digest-test-email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!emailConfigured || test.kind === "pending"}
            aria-describedby={!emailConfigured ? "digest-test-disabled" : undefined}
            className="min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3.5 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 sm:max-w-xs"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!emailConfigured || test.kind === "pending"} className="shrink-0">
            {test.kind === "pending" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Mail className="size-4" aria-hidden />}
            Send test
          </Button>
        </div>
        {!emailConfigured ? (
          <p id="digest-test-disabled" className="mt-2 text-sm text-muted">
            Test sends need email delivery, which is not configured on the API.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted">Sends this week&apos;s digest to this address only.</p>
        )}
        {test.kind === "done" && (
          <p role="status" className="mt-2 text-sm text-success">
            Sent to {test.data.sentTo} ({test.data.rules} {test.data.rules === 1 ? "rule" : "rules"}).
          </p>
        )}
        {test.kind === "error" && <ErrorText>{test.message}</ErrorText>}
      </form>

      {/* Send to everyone */}
      <div>
        {confirming ? (
          <div className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium">
              Send to {activeSubscribers} {activeSubscribers === 1 ? "subscriber" : "subscribers"} and the team now?
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => {
                  setConfirming(false);
                  void runSend("/api/digest/send", {});
                }}
              >
                Confirm
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!canSend || send.kind === "pending"}
              onClick={() => setConfirming(true)}
            >
              {send.kind === "pending" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
              Send to everyone now
            </Button>
            <p className="text-sm text-muted">
              {canSend
                ? "Delivers this week's digest outside the schedule. You confirm first."
                : "Neither email nor Slack is configured, so there is nowhere to send it."}
            </p>
          </div>
        )}
        {send.kind === "done" && (
          <p role="status" className="mt-2 text-sm text-success">
            Queued (job {send.data.jobId}). The worker delivers it shortly.
          </p>
        )}
        {send.kind === "error" && <ErrorText>{send.message}</ErrorText>}
      </div>
    </div>
  );
}
