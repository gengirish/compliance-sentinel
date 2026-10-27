import type { Metadata } from "next";
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
import { api, RUN_SORTS, RUN_STATUSES, TRIGGER_LABEL, TRIGGERS } from "@/lib/api";
import { hasAny, hrefWith, pickDate, pickList, pickPage, pickSort, toggleValue, type SearchParams } from "@/lib/list-params";
import { formatDateTime, formatDuration, formatUsd } from "@/lib/utils";

export const metadata: Metadata = { title: "Runs" };

const PATH = "/runs";
const LIMIT = 25;
const FILTER_KEYS = ["status", "trigger", "from", "to", "critical", "repo"] as const;

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

  const defaultView = !filtered && sort.isDefault && page === 1;
  // The audit button watches the newest run. Unless this is the default view, the first row is not it.
  const [{ items: runs, total }, statuses] = await Promise.all([
    api.runsPage({
      status,
      trigger,
      from,
      to,
      critical,
      repo,
      sort: sort.isDefault ? undefined : sort.sort,
      order: sort.isDefault ? undefined : sort.order,
      page: page > 1 ? page : undefined,
    }),
    defaultView ? null : api.runStatuses(),
  ]);
  const newest = (defaultView ? runs[0] : statuses?.[0]) ?? null;

  // TODO(A5): label repositories by name and list all of the tenant's repos, not just the ones on this page.
  const repoIds = [...new Set(runs.flatMap((r) => (r.repoId ? [r.repoId] : [])))];
  const href = (changes: Record<string, string | null>) => hrefWith(PATH, params, changes);
  const header = { path: PATH, params, current: sort };

  return (
    <>
      <PageHeader
        title="Audit runs"
        description={
          filtered
            ? `${plural(total, "run")} ${total === 1 ? "matches" : "match"} these filters.`
            : `${plural(total, "run")}, from the daily schedule, manual triggers and repository events.`
        }
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
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Run
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
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
                  <th scope="col" className="px-4 py-3 font-semibold">
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
                    <td className="px-4 py-3" title={run.note ?? run.error ?? undefined}>
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className="px-4 py-3 text-muted">{formatDateTime(run.startedAt)}</td>
                    <td className="px-4 py-3 text-muted">{formatDuration(run.startedAt, run.finishedAt)}</td>
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
          <Pager path={PATH} params={params} page={page} limit={LIMIT} total={total} noun="runs" />
        </>
      )}
    </>
  );
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
