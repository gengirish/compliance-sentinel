import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/page-header";
import { RunAuditButton } from "@/components/run-audit-button";
import { RunStatusBadge } from "@/components/status-badges";
import { api } from "@/lib/api";
import { formatDateTime, formatDuration, formatUsd } from "@/lib/utils";

export const metadata: Metadata = { title: "Runs" };

export default async function RunsPage() {
  const runs = await api.runs();

  return (
    <>
      <PageHeader
        title="Audit runs"
        description="The 20 most recent runs, from the daily schedule and manual triggers."
        actions={<RunAuditButton />}
      />
      {runs.length === 0 ? (
        <EmptyState title="No runs yet" />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
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
                    <Link href={`/runs/${run.id}`} className="font-medium text-accent hover:underline">
                      #{run.id}
                    </Link>
                    <span className="ml-2 text-xs text-muted">{run.trigger}</span>
                  </td>
                  <td className="px-4 py-3">
                    <RunStatusBadge status={run.status} />
                  </td>
                  <td className="px-4 py-3 text-muted">{formatDateTime(run.startedAt)}</td>
                  <td className="px-4 py-3 text-muted">{formatDuration(run.startedAt, run.finishedAt)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{run.counts?.byStatus.violation ?? 0}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-danger">{run.counts?.criticalViolations || ""}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted">{formatUsd(run.costUsd)}</td>
                  <td className="px-4 py-3 text-right">
                    {run.reportUrl && (
                      <a
                        href={`/api/reports/${run.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-muted hover:text-accent"
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
