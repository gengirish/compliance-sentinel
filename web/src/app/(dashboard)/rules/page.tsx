import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { ClearFilters } from "@/components/list/clear-filters";
import { ChipDivider, FilterChip, FilterChips } from "@/components/list/filter-chips";
import { Pager } from "@/components/list/pager";
import { SortHeader } from "@/components/list/sort-header";
import { DateRange, FilterBar, SearchBox, SelectFilter } from "@/components/list/url-controls";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import {
  hasAny,
  hrefWith,
  pickDate,
  pickLimit,
  pickOne,
  pickPage,
  pickSearch,
  pickSort,
  toggleValue,
  toQuery,
  type SearchParams,
  type SortState,
} from "@/lib/list-params";
import { cn, formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Rules" };

/*
 * Below `sm` the same table restyles into stacked cards: rows become two-column grids and each
 * cell shows its column name from `data-label` as CSS generated content. One DOM, so no text is
 * rendered twice, and the explicit roles keep the table semantics a `display` change can drop.
 */
const cell = "block min-w-0 sm:table-cell sm:px-4 sm:py-3";
const labelled =
  "before:mb-0.5 before:block before:text-xs before:font-semibold before:uppercase before:tracking-wide before:text-muted before:content-[attr(data-label)] sm:before:content-none";

const PATH = "/rules";
const SORTS = ["changed", "first_seen", "effective", "title", "source"] as const;
const DEFAULT_SORT = { sort: "changed", order: "desc" } as const;
const CHANGED_WITHIN = ["7", "30", "90"] as const;
const AUDITED = ["yes", "no"] as const;
const FILTER_KEYS = ["q", "source", "audited", "changed", "from", "to"] as const;

/** Source names as the API accepts them; anything else in the URL is dropped. */
function pickSources(raw: string | string[] | undefined): string[] {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return [...new Set((value ?? "").split(",").filter((s) => /^[a-z0-9-]{1,64}$/.test(s)))];
}

type ListQuery = {
  q?: string;
  source: string[];
  audited?: (typeof AUDITED)[number];
  changed?: (typeof CHANGED_WITHIN)[number];
  from?: string;
  to?: string;
  sort: SortState<(typeof SORTS)[number]>;
  page: number;
  limit: number;
};

export default async function RulesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const from = pickDate(params.from);
  // A reversed range would be a 400 from the API; keep the start and drop the end.
  const toRaw = pickDate(params.to);
  const query: ListQuery = {
    q: pickSearch(params.q),
    source: pickSources(params.source),
    audited: pickOne(params.audited, AUDITED),
    changed: pickOne(params.changed, CHANGED_WITHIN),
    from,
    to: from && toRaw && toRaw < from ? undefined : toRaw,
    sort: pickSort(params, SORTS, DEFAULT_SORT),
    page: pickPage(params.page),
    limit: pickLimit(params.limit, 50),
  };
  const { q, source, audited, changed, to } = query;
  const sources = await api.ruleSources();

  const filtered = hasAny(params, FILTER_KEYS);
  const active = [q, source.length, audited, changed, from || to].filter(Boolean).length;
  // Show chips for every source with rules, plus any picked in the URL that has none yet.
  const sourceNames = [...new Set([...sources.map((s) => s.name), ...source])];
  const fixtures = new Set(sources.filter((s) => s.kind === "fixture").map((s) => s.name));

  return (
    <>
      <PageHeader
        title="Tracked rules"
        description="Regulations collected from the Federal Register, the SEC, FINRA, the FCA, ESMA, ASIC, EUR-Lex and MAS. A rule is re-audited when its text changes."
      />
      {sources.length === 0 && !filtered ? (
        <EmptyState title="No rules collected yet" />
      ) : (
        <>
          <FilterBar active={active}>
            <SearchBox label="Search rules" placeholder="Search title or id" />
            <SelectFilter
              label="Audited"
              param="audited"
              options={[
                { value: "yes", label: "Audited" },
                { value: "no", label: "Never audited" },
              ]}
            />
            <DateRange label="Effective" />
            {filtered && <ClearFilters href={PATH} />}
            <FilterChips label="Source">
              {sourceNames.map((name) => (
                <FilterChip key={name} href={hrefWith(PATH, params, { source: toggleValue(source, name) })} active={source.includes(name)}>
                  {name}
                  {fixtures.has(name) && <span className="text-xs text-muted">demo</span>}
                </FilterChip>
              ))}
            </FilterChips>
            <ChipDivider />
            <FilterChips label="Changed within">
              <span className="text-sm text-muted" aria-hidden>
                Changed within
              </span>
              {CHANGED_WITHIN.map((days) => (
                <FilterChip key={days} href={hrefWith(PATH, params, { changed: changed === days ? null : days })} active={changed === days}>
                  {days}d
                </FilterChip>
              ))}
            </FilterChips>
          </FilterBar>
          {/*
            The table streams into a boundary keyed by the query. Besides showing a placeholder at
            once while the controls stay put, this works around Next 16.1.6: a navigation that
            swaps a 50-row table in place was often fetched but never committed.
          */}
          <Suspense key={toQuery(params).toString()} fallback={<TableSkeleton />}>
            <RulesTable params={params} query={query} />
          </Suspense>
        </>
      )}
    </>
  );
}

function TableSkeleton() {
  return <div className="h-96 animate-pulse rounded-xl border border-border bg-surface" aria-busy="true" aria-label="Loading rules" />;
}

async function RulesTable({ params, query }: { params: SearchParams; query: ListQuery }) {
  const { sort, page, limit } = query;
  const { items: rules, total } = await api.rulesPage({
    q: query.q,
    source: query.source.join(","),
    audited: query.audited,
    changed: query.changed,
    from: query.from,
    to: query.to,
    sort: sort.isDefault ? undefined : sort.sort,
    order: sort.isDefault ? undefined : sort.order,
    page: page > 1 ? page : undefined,
    limit: limit === 50 ? undefined : limit,
  });
  const header = { path: PATH, params, current: sort };

  if (rules.length === 0) {
    return (
      <EmptyState title={total === 0 ? "No rules match these filters" : "No rules on this page"}>
        {total === 0 ? (
          <ClearFilters href={PATH} />
        ) : (
          <Link href={hrefWith(PATH, params, { page: null })} prefetch={false} className="text-accent hover:underline">
            Back to the first page
          </Link>
        )}
      </EmptyState>
    );
  }
  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table role="table" className="block w-full text-sm sm:table sm:min-w-[900px]">
          <thead role="rowgroup" className="hidden bg-surface text-left text-xs uppercase tracking-wide text-muted sm:table-header-group">
            <tr role="row">
              <SortHeader {...header} sortKey="title" firstOrder="asc">
                Rule
              </SortHeader>
              <SortHeader {...header} sortKey="source" firstOrder="asc">
                Source
              </SortHeader>
              <SortHeader {...header} sortKey="effective">
                Effective
              </SortHeader>
              <SortHeader {...header} sortKey="first_seen">
                First seen
              </SortHeader>
              <SortHeader {...header} sortKey="changed">
                Last changed
              </SortHeader>
              <th role="columnheader" scope="col" className="px-4 py-3 font-semibold">
                Last audited
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup" className="block divide-y divide-border sm:table-row-group">
            {rules.map((r) => (
              <tr
                key={r.id}
                role="row"
                className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 align-top hover:bg-surface/60 sm:table-row sm:p-0"
              >
                <td role="cell" className={cn(cell, "col-span-2 sm:max-w-md")}>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-start gap-1 font-medium break-words hover:text-accent"
                  >
                    {r.title}
                    <ExternalLink className="mt-1 size-3 shrink-0" aria-hidden />
                  </a>
                  <p className="font-mono text-xs break-all text-muted">{r.externalId}</p>
                </td>
                <td role="cell" data-label="Source" className={cn(cell, labelled)}>
                  <Badge tone={r.source.kind === "fixture" ? "neutral" : "primary"}>{r.source.name}</Badge>
                </td>
                <td role="cell" data-label="Effective" className={cn(cell, labelled, "text-muted")}>
                  {r.effectiveDate ?? "—"}
                </td>
                <td role="cell" data-label="First seen" className={cn(cell, labelled, "text-muted")}>
                  {formatDateTime(r.firstSeenAt)}
                </td>
                <td role="cell" data-label="Last changed" className={cn(cell, labelled, "text-muted")}>
                  {formatDateTime(r.lastChangedAt)}
                </td>
                <td role="cell" data-label="Last audited" className={cn(cell, labelled)}>
                  {r.lastAuditedRunId ? (
                    <Link href={`/runs/${r.lastAuditedRunId}`} prefetch={false} className="text-accent hover:underline">
                      Run #{r.lastAuditedRunId}
                    </Link>
                  ) : (
                    <span className="text-muted">Not yet</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager path={PATH} params={params} page={page} limit={limit} total={total} noun="rules" />
    </>
  );
}
