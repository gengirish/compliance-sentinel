import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink, Search } from "lucide-react";
import { ClearFilters } from "@/components/list/clear-filters";
import { Pager } from "@/components/list/pager";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { hasAny, pickLimit, pickOne, pickPage, pickSearch, type SearchParams } from "@/lib/list-params";
import { cn, formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Rules" };

const PAGE_SIZE = 50;

/* Below `sm` rows restyle into stacked cards; see the runs page for how the one DOM serves both. */
const cell = "block min-w-0 sm:table-cell sm:px-4 sm:py-3";
const labelled =
  "before:mb-0.5 before:block before:text-xs before:font-semibold before:uppercase before:tracking-wide before:text-muted before:content-[attr(data-label)] sm:before:content-none";
const field =
  "min-h-11 rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-accent";

export default async function RulesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const search = await searchParams;
  const q = pickSearch(search.q);
  const page = pickPage(search.page);
  const limit = pickLimit(search.limit, PAGE_SIZE);
  // Every rule, for the source choices: rules are shared and number in the dozens, and the
  // operator-only source catalog is not readable by every tenant.
  const all = await api.rules();
  const sourceNames = [...new Set(all.items.map((r) => r.source.name))].sort();
  // A source that is not (or no longer) collected is dropped, so an old link shows every source.
  const source = pickOne(search.source, sourceNames);
  const filtered = Boolean(q || source);
  const { items: rules, total } = filtered || page > 1 || limit !== PAGE_SIZE
    ? await api.rules({ q, source: source ? [source] : undefined, page, limit })
    : { items: all.items.slice(0, limit), total: all.total };

  return (
    <>
      <PageHeader
        title="Tracked rules"
        description="Regulations collected from the Federal Register, the SEC, FINRA, the FCA, ESMA, ASIC, EUR-Lex and MAS. A rule is re-audited when its text changes."
      />
      {all.total === 0 ? (
        <EmptyState title="No rules collected yet" />
      ) : (
        <>
          {/* A plain GET form: it works before hydration, and the result is a shareable URL. */}
          <form action="/rules" method="get" role="search" className="mb-4 flex flex-wrap items-end gap-3">
            <div className="flex w-full flex-col gap-1 sm:w-auto">
              <label htmlFor="rules-q" className="text-xs font-semibold uppercase tracking-wide text-muted">
                Search
              </label>
              <div className="relative flex items-center">
                <Search className="pointer-events-none absolute left-3 size-4 text-muted" aria-hidden />
                <input
                  id="rules-q"
                  type="search"
                  name="q"
                  defaultValue={q ?? ""}
                  maxLength={100}
                  placeholder="Title or id, such as 17a-4"
                  className={cn(field, "w-full pl-9 sm:w-72")}
                />
              </div>
            </div>
            <div className="flex w-full flex-col gap-1 sm:w-auto">
              <label htmlFor="rules-source" className="text-xs font-semibold uppercase tracking-wide text-muted">
                Source
              </label>
              <select id="rules-source" name="source" defaultValue={source ?? ""} className={cn(field, "w-full sm:w-48")}>
                <option value="">All sources</option>
                {sourceNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" variant="secondary">
                Search
              </Button>
              {hasAny(search, ["q", "source"]) && <ClearFilters href="/rules" />}
            </div>
          </form>

          {rules.length === 0 ? (
            <EmptyState title={filtered && total === 0 ? "No rules match" : "No rules on this page"}>
              <Link href="/rules" prefetch={false} className="inline-flex min-h-11 items-center text-accent hover:underline">
                {filtered ? "Clear the search and show every rule" : "Go to the first page"}
              </Link>
            </EmptyState>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table role="table" className="block w-full text-sm sm:table sm:min-w-[760px]">
                <thead role="rowgroup" className="hidden bg-surface text-left text-xs uppercase tracking-wide text-muted sm:table-header-group">
                  <tr role="row">
                    <th role="columnheader" className="px-4 py-3 font-semibold">
                      Rule
                    </th>
                    <th role="columnheader" className="px-4 py-3 font-semibold">
                      Source
                    </th>
                    <th role="columnheader" className="px-4 py-3 font-semibold">
                      Effective
                    </th>
                    <th role="columnheader" className="px-4 py-3 font-semibold">
                      Last changed
                    </th>
                    <th role="columnheader" className="px-4 py-3 font-semibold">
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
          )}
          {total > 0 && <Pager path="/rules" params={search} page={page} limit={limit} total={total} noun="rules" />}
        </>
      )}
    </>
  );
}
