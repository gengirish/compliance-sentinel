import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { FileText } from "lucide-react";
import { ClearFilters } from "@/components/list/clear-filters";
import { ChipDivider, FilterChip, FilterChips } from "@/components/list/filter-chips";
import { Pager } from "@/components/list/pager";
import { SortHeader } from "@/components/list/sort-header";
import { DateRange, FilterBar, SelectFilter } from "@/components/list/url-controls";
import { EmptyState, PageHeader } from "@/components/page-header";
import { RunAuditButton } from "@/components/run-audit-button";
import { RunStatusBadge } from "@/components/status-badges";
import { api, RUN_SORTS, RUN_STATUSES, TRIGGER_LABEL, TRIGGERS, type Run } from "@/lib/api";
import {
  hasAny,
  hrefWith,
  pickDate,
  pickList,
  pickPage,
  pickSort,
  toggleValue,
  toQuery,
  type SearchParams,
  type SortState,
} from "@/lib/list-params";
import { cn, formatDateTime, formatDuration, formatUsd } from "@/lib/utils";

export const metadata: Metadata = { title: "Runs" };

const PATH = "/runs";
const LIMIT = 25;
const FILTER_KEYS = ["status", "trigger", "from", "to", "critical", "repo"] as const;

/*
 * Below `sm` the same table restyles into stacked cards: rows become two-column grids and each
 * cell shows its column name from `data-label` as CSS generated content. One DOM, so no text is
 * rendered twice, and the explicit roles keep the table semantics a `display` change can drop.
 */
const cell = "block min-w-0 sm:table-cell sm:px-4 sm:py-3";
const labelled =
  "before:mb-0.5 before:block before:text-xs before:font-semibold before:uppercase before:tracking-wide before:text-muted before:content-[attr(data-label)] sm:before:content-none";

export default async function RunsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const status = pickList(params.status, RUN_STATUSES);
  const trigger = pickList(params.trigger, TRIGGERS);
  const from = pickDate(params.from);
  // A range that ends before it starts is a 400 at the API; drop the end instead.
  const toParam = pickDate(params.to);
  const to = from && toParam && toParam < from ? undefined : toParam;
  const critical = params.critical === "1";
  const repoParam = Number(params.repo);
  const repo = Number.isInteger(repoParam) && repoParam > 0 ? repoParam : undefined;
  const sort = pickSort(params, RUN_SORTS, { sort: "started", order: "desc" });
  const page = pickPage(params.page);
  const activeFilters = [status.length, trigger.length, from || to, critical, repo].filter(Boolean).length;
  const filtered = activeFilters > 0;

  // The newest runs, whatever the filters: the audit button watches the newest one, and the
  // repository select lists the repos among them. The filtered page streams in below.
  const { items: recent, total: allRuns } = await api.runsPage();
  const newest = recent[0] ?? null;

  // TODO(A5): label repositories by name and list all of the tenant's repos, not just the recent ones.
  const repoIds = [...new Set(recent.flatMap((r) => (r.repoId ? [r.repoId] : [])))];
  const href = (changes: Record<string, string | null>) => hrefWith(PATH, params, changes);
  const query: RunsView = { status, trigger, from, to, critical, repo, sort, page, filtered };

  return (
    <>
      <PageHeader
        title="Audit runs"
        description={`${plural(allRuns, "run")}, from the daily schedule, manual triggers and repository events.`}
        actions={<RunAuditButton latestRun={newest} />}
      />
      <FilterBar active={activeFilters}>
        <FilterChips label="Filter runs by status">
          {RUN_STATUSES.map((s) => (
            <FilterChip key={s} href={href({ status: toggleValue(status, s) })} active={status.includes(s)}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </FilterChip>
          ))}
        </FilterChips>
        <ChipDivider />
        <FilterChips label="Filter runs by trigger">
          {TRIGGERS.map((t) => (
            <FilterChip key={t} href={href({ trigger: toggleValue(trigger, t) })} active={trigger.includes(t)}>
              {TRIGGER_LABEL[t]}
            </FilterChip>
          ))}
        </FilterChips>
        <ChipDivider />
        <FilterChip href={href({ critical: critical ? null : "1" })} active={critical}>
          Critical only
        </FilterChip>
        <DateRange label="Started" />
        {(repoIds.length > 1 || repo !== undefined) && (
          <SelectFilter
            label="Repository"
            param="repo"
            allLabel="All repositories"
            options={[...new Set([...repoIds, ...(repo ? [repo] : [])])].map((id) => ({ value: String(id), label: `Repository #${id}` }))}
          />
        )}
        {hasAny(params, [...FILTER_KEYS, "sort", "order", "page"]) && <ClearFilters href={PATH} />}
      </FilterBar>

      {/*
        The table streams into a boundary keyed by the query, as on the rules page: besides a
        placeholder at once while the controls stay put, this works around Next 16.1.6, where a
        navigation that swaps a table of 25 or more rows in place was often fetched but never committed.
      */}
      <Suspense key={toQuery(params).toString()} fallback={<TableSkeleton />}>
        <RunsTable params={params} query={query} />
      </Suspense>
    </>
  );
}

type RunsView = {
  status: (typeof RUN_STATUSES)[number][];
  trigger: (typeof TRIGGERS)[number][];
  from?: string;
  to?: string;
  critical: boolean;
  repo?: number;
  sort: SortState<(typeof RUN_SORTS)[number]>;
  page: number;
  filtered: boolean;
};

function TableSkeleton() {
  return <div className="h-96 animate-pulse rounded-xl border border-border bg-surface" aria-busy="true" aria-label="Loading runs" />;
}

async function RunsTable({ params, query }: { params: SearchParams; query: RunsView }) {
  const { sort, page, filtered } = query;
  const { items: runs, total } = await api.runsPage({
    status: query.status,
    trigger: query.trigger,
    from: query.from,
    to: query.to,
    critical: query.critical,
    repo: query.repo,
    sort: sort.isDefault ? undefined : sort.sort,
    order: sort.isDefault ? undefined : sort.order,
    page: page > 1 ? page : undefined,
  });
  const href = (changes: Record<string, string | null>) => hrefWith(PATH, params, changes);
  const header = { path: PATH, params, current: sort };

  return (
    <>
      {filtered && total > 0 && (
        <p className="mb-3 text-sm text-muted">
          {plural(total, "run")} {total === 1 ? "matches" : "match"} these filters.
        </p>
      )}
    {runs.length === 0 ? (
      total > 0 ? (
        <EmptyState title="No runs on this page">
          <Link href={href({ page: null })} prefetch={false} className="text-accent hover:underline">
            Back to the first page
          </Link>
        </EmptyState>
      ) : filtered ? (
        <EmptyState title="No runs match these filters">
          <ClearFilters href={PATH} />
        </EmptyState>
      ) : (
        <EmptyState title="No runs yet" />
      )
    ) : (
      <>
        <div className="relative overflow-x-auto rounded-xl border border-border">
          <table role="table" className="block w-full text-sm sm:table sm:min-w-[720px]">
            <thead role="rowgroup" className="hidden bg-surface text-left text-xs uppercase tracking-wide text-muted sm:table-header-group">
              <tr role="row">
                <th role="columnheader" scope="col" className="px-4 py-3 font-semibold">
                  Run
                </th>
                <th role="columnheader" scope="col" className="px-4 py-3 font-semibold">
                  Status
                </th>
                <SortHeader {...header} sortKey="started">
                  Started
                </SortHeader>
                <SortHeader {...header} sortKey="duration">
                  Duration
                </SortHeader>
                <SortHeader {...header} sortKey="violations" align="right">
                  Violations
                </SortHeader>
                <SortHeader {...header} sortKey="critical" align="right">
                  Critical
                </SortHeader>
                <SortHeader {...header} sortKey="cost" align="right">
                  Cost
                </SortHeader>
                <th role="columnheader" scope="col" className="px-4 py-3 font-semibold">
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
                    <Link
                      href={`/runs/${run.id}`}
                      prefetch={false}
                      className="relative font-medium text-accent hover:underline before:absolute before:-inset-x-2 before:-inset-y-3.5"
                    >
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
        <Pager path={PATH} params={params} page={page} limit={LIMIT} total={total} noun="runs" labels={sort.isDefault ? { previous: "Newer", next: "Older" } : undefined} />
      </>
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

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function NoValue() {
  return (
    <span className="text-muted" aria-label="none">
      —
    </span>
  );
}
