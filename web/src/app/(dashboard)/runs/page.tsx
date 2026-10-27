import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { Pager } from "@/components/list/pager";
import { EmptyState, PageHeader } from "@/components/page-header";
import { RunAuditButton } from "@/components/run-audit-button";
import { RunStatusBadge } from "@/components/status-badges";
import { api, TRIGGER_LABEL, type Run } from "@/lib/api";
import { hrefWith, pickLimit, pickPage, type SearchParams } from "@/lib/list-params";
import { cn, formatDateTime, formatDuration, formatUsd } from "@/lib/utils";

export const metadata: Metadata = { title: "Runs" };

const PAGE_SIZE = 25;

/*
 * Below `sm` the same table restyles into stacked cards: rows become two-column grids and each
 * cell shows its column name from `data-label` as CSS generated content. One DOM, so no text is
 * rendered twice, and the explicit roles keep the table semantics a `display` change can drop.
 */
const cell = "block min-w-0 sm:table-cell sm:px-4 sm:py-3";
const labelled =
  "before:mb-0.5 before:block before:text-xs before:font-semibold before:uppercase before:tracking-wide before:text-muted before:content-[attr(data-label)] sm:before:content-none";

export default async function RunsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const search = await searchParams;
  const page = pickPage(search.page);
  const limit = pickLimit(search.limit, PAGE_SIZE);
  const [{ items: runs, total }, newest] = await Promise.all([
    api.runs({ page, limit }),
    // The audit button watches the newest run overall, not the top of an older page.
    page > 1 ? api.runStatuses().then((r) => r[0] ?? null) : Promise.resolve(null),
  ]);
  const latestRun = page > 1 ? newest : (runs[0] ?? null);

  return (
    <>
      <PageHeader
        title="Audit runs"
        description={
          total === 0
            ? "Runs from the daily schedule and manual triggers."
            : `${total} ${total === 1 ? "run" : "runs"}, newest first, from the daily schedule and manual triggers.`
        }
        actions={<RunAuditButton latestRun={latestRun} />}
      />
      {total === 0 ? (
        <EmptyState title="No runs yet" />
      ) : runs.length === 0 ? (
        <EmptyState title="No runs on this page">
          <Link
            href={hrefWith("/runs", search, { page: null })}
            prefetch={false}
            className="inline-flex min-h-11 items-center text-accent hover:underline"
          >
            Go to the newest runs
          </Link>
        </EmptyState>
      ) : (
        <div className="relative overflow-x-auto rounded-xl border border-border">
          <table role="table" className="block w-full text-sm sm:table sm:min-w-[720px]">
            <thead role="rowgroup" className="hidden bg-surface text-left text-xs uppercase tracking-wide text-muted sm:table-header-group">
              <tr role="row">
                <th role="columnheader" className="px-4 py-3 font-semibold">
                  Run
                </th>
                <th role="columnheader" className="px-4 py-3 font-semibold">
                  Status
                </th>
                <th role="columnheader" className="px-4 py-3 font-semibold">
                  Started
                </th>
                <th role="columnheader" className="px-4 py-3 font-semibold">
                  Duration
                </th>
                <th role="columnheader" className="px-4 py-3 text-right font-semibold">
                  Violations
                </th>
                <th role="columnheader" className="px-4 py-3 text-right font-semibold">
                  Critical
                </th>
                <th role="columnheader" className="px-4 py-3 text-right font-semibold">
                  Cost
                </th>
                <th role="columnheader" className="px-4 py-3 font-semibold">
                  <span className="sr-only">Report</span>
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="block divide-y divide-border sm:table-row-group">
              {runs.map((run) => (
                <tr
                  key={run.id}
                  role="row"
                  className="relative grid grid-cols-2 gap-x-4 gap-y-3 p-4 hover:bg-surface/60 sm:table-row sm:p-0"
                >
                  <td role="cell" className={cn(cell, "col-span-2 pr-12 sm:pr-4")}>
                    <Link href={`/runs/${run.id}`} prefetch={false} className="relative font-medium text-accent hover:underline before:absolute before:-inset-x-2 before:-inset-y-3.5">
                      #{run.id}
                    </Link>
                    <span className="ml-2 text-xs text-muted">{TRIGGER_LABEL[run.trigger]}</span>
                  </td>
                  <td role="cell" data-label="Status" className={cn(cell, labelled, "col-span-2")} title={reason(run)}>
                    <RunStatusBadge status={run.status} />
                    {(run.status === "skipped" || run.status === "failed") && reason(run) && (
                      <p className="mt-1 max-w-full text-xs text-muted sm:max-w-56 sm:truncate">{reason(run)}</p>
                    )}
                  </td>
                  <td role="cell" data-label="Started" className={cn(cell, labelled, "text-muted")}>
                    {formatDateTime(run.startedAt)}
                  </td>
                  <td role="cell" data-label="Duration" className={cn(cell, labelled, "text-muted")}>
                    {runDuration(run)}
                  </td>
                  {/* Only a completed run has counts worth showing; a zero from a skipped or failed run would mislead. */}
                  <td role="cell" data-label="Violations" className={cn(cell, labelled, "tabular-nums sm:text-right")}>
                    {run.status === "completed" ? (run.counts?.byStatus.violation ?? 0) : <NoValue />}
                  </td>
                  <td role="cell" data-label="Critical" className={cn(cell, labelled, "tabular-nums text-danger sm:text-right")}>
                    {run.status === "completed" && run.counts?.criticalViolations ? run.counts.criticalViolations : <NoValue />}
                  </td>
                  <td role="cell" data-label="Cost" className={cn(cell, labelled, "tabular-nums text-muted sm:text-right")}>
                    {formatUsd(run.costUsd)}
                  </td>
                  {/* On a card the report icon sits in the top corner, beside the run number. */}
                  <td role="cell" className={cn(cell, "absolute right-2 top-2 sm:static sm:text-right")}>
                    {run.reportUrl && (
                      <a
                        href={`/api/reports/${run.id}`}
                        target="_blank"
                        rel="noreferrer"
                        // A 44px target; the negative margin keeps the table row as short as the text rows.
                        className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:text-accent sm:-my-3"
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
      {total > 0 && (
        <Pager
          path="/runs"
          params={search}
          page={page}
          limit={limit}
          total={total}
          noun="runs"
          labels={{ previous: "Newer", next: "Older" }}
        />
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
