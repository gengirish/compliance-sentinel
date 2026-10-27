import { cache, Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText } from "lucide-react";
import { FindingCard } from "@/components/finding-card";
import { ClearFilters } from "@/components/list/clear-filters";
import { ChipDivider, FilterChip, FilterChips } from "@/components/list/filter-chips";
import { SortSelect } from "@/components/list/sort-select";
import { FilterBar, SearchBox, SelectFilter } from "@/components/list/url-controls";
import { EmptyState, PageHeader } from "@/components/page-header";
import { RefreshWhileRunning } from "@/components/refresh-while";
import { RunStatusBadge, STATUS_LABEL } from "@/components/status-badges";
import { buttonVariants } from "@/components/ui/button";
import {
  ApiError,
  api,
  FINDING_SORTS,
  FINDING_STATUSES,
  SEVERITIES,
  TRIGGER_LABEL,
  type Finding,
  type FindingSort,
  type FindingsFilter,
  type Run,
} from "@/lib/api";
import { hasAny, hrefWith, pickList, pickSearch, pickSort, toggleValue, type SearchParams } from "@/lib/list-params";
import { formatDateTime, formatDuration, formatUsd } from "@/lib/utils";

type Params = { id: string };

/** Every parameter of the findings view; Clear drops them all. */
const VIEW_KEYS = ["status", "severity", "rule", "path", "q", "sort", "order"] as const;
const DEFAULT_SORT = { sort: "severity", order: "desc" } as const satisfies { sort: FindingSort; order: "desc" };
const SORT_OPTIONS = [
  { value: "severity", label: "Severity", firstOrder: "desc" },
  { value: "status", label: "Status", firstOrder: "desc" },
  { value: "rule", label: "Rule", firstOrder: "asc" },
  { value: "path", label: "File", firstOrder: "asc" },
] as const satisfies { value: FindingSort; label: string; firstOrder: "asc" | "desc" }[];

/** The run, or null when it does not exist. Cached so metadata and the page share one API call. */
const getRun = cache(async (id: number): Promise<Run | null> => {
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    return await api.run(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
});

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  // A tab or history entry titled "Run #999" would suggest the run exists.
  const run = await getRun(Number((await params).id));
  return { title: run ? `Run #${run.id}` : "Run not found" };
}

/** A rule id from the URL; anything else is dropped rather than sent to the API. */
function pickRuleId(raw: string | string[] | undefined): number | undefined {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The rules that have findings, by title, for the rule select. */
function ruleOptions(findings: Finding[]): { value: string; label: string }[] {
  const byId = new Map(findings.map((f) => [f.rule.id, f.rule.title]));
  return [...byId]
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([id, title]) => ({ value: String(id), label: title }));
}

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<SearchParams>;
}) {
  const id = Number((await params).id);
  const search = await searchParams;
  const status = pickList(search.status, FINDING_STATUSES);
  const severity = pickList(search.severity, SEVERITIES);
  const rule = pickRuleId(search.rule);
  const path = pickSearch(search.path);
  const q = pickSearch(search.q);
  const sort = pickSort(search, FINDING_SORTS, DEFAULT_SORT);
  const filtered = status.length > 0 || severity.length > 0 || rule !== undefined || path !== undefined || q !== undefined;

  // Looked up before anything streams: with a loading.tsx or Suspense above this point the response
  // would already be a 200 when notFound() runs. Only the findings below stream in.
  const run = await getRun(id);
  if (!run) notFound();
  const filter: FindingsFilter = { status, severity, rule, path, q, ...(sort.isDefault ? {} : { sort: sort.sort, order: sort.order }) };
  const base = `/runs/${id}`;

  /** Link that toggles one chip value and keeps every other parameter. */
  const toggle = (key: "status" | "severity", value: string) =>
    hrefWith(base, search, { [key]: toggleValue(key === "status" ? status : severity, value) });

  return (
    <>
      <Link href="/runs" className="mb-2 inline-flex min-h-11 items-center gap-1 text-sm text-muted hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> All runs
      </Link>
      <RefreshWhileRunning runId={run.id} status={run.status} />
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Run #{run.id} <RunStatusBadge status={run.status} />
          </span>
        }
        description={`${TRIGGER_LABEL[run.trigger]} · started ${formatDateTime(run.startedAt)} · ${runDuration(run)} · ${run.rulesInScope.length} rules · ${formatUsd(run.costUsd)}`}
        actions={
          run.reportUrl && (
            <a
              href={`/api/reports/${run.id}`}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "secondary" })}
            >
              <FileText className="size-4" aria-hidden /> Open report
            </a>
          )
        }
      />

      {run.note && (
        <p className="mb-6 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">{run.note}</p>
      )}
      {run.error && (
        <p className="mb-6 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{run.error}</p>
      )}

      <div className="mb-3">
        <FilterChips label="Filter findings">
          {FINDING_STATUSES.map((s) => (
            <FilterChip key={s} href={toggle("status", s)} active={status.includes(s)}>
              {STATUS_LABEL[s]} <span className="tabular-nums text-muted">{run.counts?.byStatus[s] ?? 0}</span>
            </FilterChip>
          ))}
          <ChipDivider />
          {SEVERITIES.map((s) => (
            <FilterChip key={s} href={toggle("severity", s)} active={severity.includes(s)}>
              {s[0]!.toUpperCase() + s.slice(1)}{" "}
              <span className="tabular-nums text-muted">{run.counts?.bySeverity[s] ?? 0}</span>
            </FilterChip>
          ))}
          {hasAny(search, VIEW_KEYS) && (
            <span className="ml-1">
              <ClearFilters href={base} />
            </span>
          )}
        </FilterChips>
      </div>

      {/* Unkeyed, so the search boxes keep focus and their text while the list below reloads. */}
      <Suspense fallback={null}>
        <FindingsFilterBar run={run} active={[rule, path, q].filter((v) => v !== undefined).length} />
      </Suspense>

      <h2 className="sr-only">Findings</h2>
      <Suspense key={JSON.stringify(filter)} fallback={<FindingsSkeleton />}>
        <FindingsList run={run} filter={filtered || !sort.isDefault ? filter : null} narrowed={filtered} base={base} />
      </Suspense>
    </>
  );
}

/** Every finding of a run, unfiltered. Cached so the filter bar and an unfiltered list share one call. */
const getAllFindings = cache((id: number) => api.findings(id));

/** The rule select lists every rule of the run, so it needs the unfiltered findings. */
async function FindingsFilterBar({ run, active }: { run: Run; active: number }) {
  const all = await getAllFindings(run.id);
  if ((run.counts?.total ?? all.length) === 0) return null;
  return (
    <FilterBar active={active}>
      <SelectFilter label="Rule" param="rule" options={ruleOptions(all)} allLabel="All rules" />
      <SearchBox label="File path starts with" placeholder="File path, e.g. src/payments" param="path" />
      <SearchBox label="Search findings" placeholder="Search obligations" />
      <SortSelect options={[...SORT_OPTIONS]} defaults={DEFAULT_SORT} />
    </FilterBar>
  );
}

/** `filter` is null for the default view, which is the unfiltered list in its default order. */
async function FindingsList({
  run,
  filter,
  narrowed,
  base,
}: {
  run: Run;
  filter: FindingsFilter | null;
  narrowed: boolean;
  base: string;
}) {
  const findings = filter ? await api.findings(run.id, filter) : await getAllFindings(run.id);
  const total = run.counts?.total ?? findings.length;

  if (findings.length === 0) {
    const title = total
      ? "No findings match these filters"
      : run.status === "running"
        ? "Audit in progress. Findings appear here when it finishes."
        : "This run produced no findings";
    return <EmptyState title={title}>{total > 0 && <ClearFilters href={base} />}</EmptyState>;
  }
  return (
    <>
      {total > 0 && narrowed && (
        <p className="mb-4 text-sm text-muted" aria-live="polite">
          {findings.length} of {total} findings
        </p>
      )}
      <div className="space-y-4">
        {findings.map((f) => (
          <FindingCard key={f.id} finding={f} repoUrl={run.repo?.url} sha={run.headSha ?? undefined} />
        ))}
      </div>
    </>
  );
}

/** The cards half of the old route skeleton; the header above is already real by then. */
function FindingsSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-busy="true">
      <span className="sr-only">Loading findings…</span>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="space-y-3 rounded-xl border border-border bg-surface p-5">
          <div className="flex gap-2">
            <div className="h-5 w-20 animate-pulse rounded-full bg-surface-light" />
            <div className="h-5 w-16 animate-pulse rounded-full bg-surface-light" />
          </div>
          <div className="h-5 w-2/3 animate-pulse rounded bg-surface-light" />
          <div className="h-3 w-full animate-pulse rounded bg-surface-light" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-surface-light" />
        </div>
      ))}
    </div>
  );
}

/** How long the run took, or for one still going, how long it has been going so far. */
function runDuration(run: Run): string {
  if (run.status === "running" && !run.finishedAt) {
    return `${formatDuration(run.startedAt, new Date().toISOString())} so far`;
  }
  return formatDuration(run.startedAt, run.finishedAt);
}
