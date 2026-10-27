import { cache } from "react";
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

  const run = await getRun(id);
  if (!run) notFound();
  const [findings, all] = await Promise.all([
    api.findings(id, { status, severity, rule, path, q, ...(sort.isDefault ? {} : { sort: sort.sort, order: sort.order }) }),
    // The rule select lists every rule of the run, so it needs the unfiltered list; an unfiltered view already is one.
    filtered ? api.findings(id) : null,
  ]);
  const rules = ruleOptions(all ?? findings);
  const total = run.counts?.total ?? all?.length ?? findings.length;
  const base = `/runs/${id}`;

  /** Link that toggles one chip value and keeps every other parameter. */
  const toggle = (key: "status" | "severity", value: string) =>
    hrefWith(base, search, { [key]: toggleValue(key === "status" ? status : severity, value) });

  return (
    <>
      <Link href="/runs" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> All runs
      </Link>
      <RefreshWhileRunning runId={run.id} status={run.status} />
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Run #{run.id} <RunStatusBadge status={run.status} />
          </span>
        }
        description={`${TRIGGER_LABEL[run.trigger]} · started ${formatDateTime(run.startedAt)} · ${formatDuration(run.startedAt, run.finishedAt)} · ${run.rulesInScope.length} rules · ${formatUsd(run.costUsd)}`}
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

      {total > 0 && (
        <FilterBar active={[rule, path, q].filter((v) => v !== undefined).length}>
          <SelectFilter label="Rule" param="rule" options={rules} allLabel="All rules" />
          <SearchBox label="File path starts with" placeholder="File path, e.g. src/payments" param="path" />
          <SearchBox label="Search findings" placeholder="Search obligations" />
          <SortSelect options={[...SORT_OPTIONS]} defaults={DEFAULT_SORT} />
        </FilterBar>
      )}

      {total > 0 && filtered && (
        <p className="mb-4 text-sm text-muted" aria-live="polite">
          {findings.length} of {total} findings
        </p>
      )}

      {findings.length === 0 ? (
        <EmptyState title={total ? "No findings match these filters" : "This run produced no findings"}>
          {total > 0 && <ClearFilters href={base} />}
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {findings.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      )}
    </>
  );
}
