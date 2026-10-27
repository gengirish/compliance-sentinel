import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/page-header";
import { RunAuditButton } from "@/components/run-audit-button";
import { RunStatusBadge } from "@/components/status-badges";
import { api, TRIGGER_LABEL, type Run } from "@/lib/api";
import { formatDateTime, formatDuration, formatUsd } from "@/lib/utils";

export const metadata: Metadata = { title: "Runs" };

export default async function RunsPage() {
  const runs = await api.runs();

  return (
    <>
      <PageHeader
        title="Audit runs"
        description="The 20 most recent runs, from the daily schedule and manual triggers."
        actions={<RunAuditButton latestRun={runs[0] ?? null} />}
      />
      {runs.length === 0 ? (
        <EmptyState title="No runs yet" />
      ) : (
        <div className="relative overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Run</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Started</th>
                <th className="px-4 py-3 font-semibold">Duration</th>
                <th className="px-4 py-3 text-right font-semibold">Violations</th>
                <th className="px-4 py-3 text-right font-semibold">Critical</th>
                <th className="px-4 py-3 text-right font-semibold">Cost</th>
                <th className="px-4 py-3 font-semibold">
                  <span className="sr-only">Report</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-surface/60">
                  <td className="px-4 py-3">
                    <Link href={`/runs/${run.id}`} prefetch={false} className="font-medium text-accent hover:underline">
                      #{run.id}
                    </Link>
                    <span className="ml-2 text-xs text-muted">{TRIGGER_LABEL[run.trigger]}</span>
                  </td>
                  <td className="px-4 py-3" title={reason(run)}>
                    <RunStatusBadge status={run.status} />
                    {(run.status === "skipped" || run.status === "failed") && reason(run) && (
                      <p className="mt-1 max-w-56 truncate text-xs text-muted">{reason(run)}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted">{formatDateTime(run.startedAt)}</td>
                  <td className="px-4 py-3 text-muted">{runDuration(run)}</td>
                  {/* Only a completed run has counts worth showing; a zero from a skipped or failed run would mislead. */}
                  <td className="px-4 py-3 text-right tabular-nums">
                    {run.status === "completed" ? (run.counts?.byStatus.violation ?? 0) : <NoValue />}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-danger">
                    {run.status === "completed" && run.counts?.criticalViolations ? run.counts.criticalViolations : <NoValue />}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted">{formatUsd(run.costUsd)}</td>
                  <td className="px-4 py-3 text-right">
                    {run.reportUrl && (
                      <a
                        href={`/api/reports/${run.id}`}
                        target="_blank"
                        rel="noreferrer"
                        // A 44px target; the negative margin keeps the row as short as the text rows.
                        className="-my-3 inline-flex size-11 items-center justify-center rounded-md text-muted hover:text-accent"
                        aria-label={`Report for run ${run.id}`}
                      >
                        <FileText className="size-4" aria-hidden />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Why a run was skipped or failed, if the API said. */
function reason(run: Run): string | undefined {
  return run.note ?? run.error ?? undefined;
}

/** How long the run took, or for one still going, how long it has been going so far. */
function runDuration(run: Run): string {
  if (run.status === "running" && !run.finishedAt) {
    return `${formatDuration(run.startedAt, new Date().toISOString())} so far`;
  }
  return formatDuration(run.startedAt, run.finishedAt);
}

function NoValue() {
  return (
    <span className="text-muted" aria-label="none">
      —
    </span>
  );
}
