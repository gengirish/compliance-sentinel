import type { Metadata } from "next";
import { ArrowDown, ArrowUp, ExternalLink } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/page-header";
import { SourceSwitch } from "@/components/source-switch";
import { ClearFilters } from "@/components/list/clear-filters";
import { ChipDivider, FilterChip, FilterChips } from "@/components/list/filter-chips";
import { FilterBar } from "@/components/list/url-controls";
import { Badge } from "@/components/ui/badge";
import { api, ApiError, type Source } from "@/lib/api";
import { hasAny, hrefWith, pickList, pickOne, pickSort, toggleValue, type SearchParams, type SortOrder } from "@/lib/list-params";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Settings" };

const PATH = "/settings";
const STATES = ["on", "off"] as const;
const SET_BY = ["here", "default"] as const;
const SORT_KEYS = ["name", "region", "rules", "checked"] as const;
type SortKey = (typeof SORT_KEYS)[number];
const DEFAULT_SORT = { sort: "name", order: "asc" } as const;
const FILTER_KEYS = ["state", "region", "set"];

/** Sort chips, with the direction each sorts in first: names and regions A–Z, the most rules and the latest check first. */
const SORTS: { key: SortKey; label: string; firstOrder: SortOrder }[] = [
  { key: "name", label: "Name", firstOrder: "asc" },
  { key: "region", label: "Region", firstOrder: "asc" },
  { key: "rules", label: "Rules collected", firstOrder: "desc" },
  { key: "checked", label: "Last checked", firstOrder: "desc" },
];

const byName = (a: Source, b: Source) => a.label.localeCompare(b.label);

/** Compares in `order`, then by name. A source never checked sorts last in either direction. */
function compare(key: SortKey, order: SortOrder) {
  const dir = order === "asc" ? 1 : -1;
  return (a: Source, b: Source): number => {
    if (key === "checked" && (a.lastCheckedAt === null) !== (b.lastCheckedAt === null)) return a.lastCheckedAt === null ? 1 : -1;
    const primary =
      key === "region"
        ? a.region.localeCompare(b.region)
        : key === "rules"
          ? a.rules - b.rules
          : key === "checked"
            ? Date.parse(a.lastCheckedAt ?? "") - Date.parse(b.lastCheckedAt ?? "")
            : byName(a, b);
    return dir * primary || byName(a, b);
  };
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const search = await searchParams;
  let sources;
  try {
    sources = await api.sources();
  } catch (err) {
    // The API keeps the switches to the operator; anyone else gets an explanation, not an error page.
    if (err instanceof ApiError && err.status === 403) {
      return (
        <>
          <PageHeader title="Settings" />
          <EmptyState title="Only the operator can configure sources">
            Ask the operator of this deployment to change which sources are scraped.
          </EmptyState>
        </>
      );
    }
    throw err;
  }
  // The warning is about the scheduler, so it counts every source, not just the ones shown.
  const enabled = sources.filter((s) => s.enabled).length;

  // Eight rows are already on the page, so they are filtered and sorted here rather than by the
  // API. The URL still holds the view, so it can be shared and survives a switch's refresh.
  const regions = [...new Set(sources.map((s) => s.region))];
  const state = pickOne(search.state, STATES);
  const region = pickList(search.region, regions);
  const setBy = pickOne(search.set, SET_BY);
  const sort = pickSort<SortKey>(search, SORT_KEYS, DEFAULT_SORT);
  const shown = sources
    .filter(
      (s) =>
        (!state || s.enabled === (state === "on")) &&
        (region.length === 0 || region.includes(s.region)) &&
        (!setBy || s.overridden === (setBy === "here")),
    )
    .sort(compare(sort.sort, sort.order));

  const only = (param: string, value: string, current: string | undefined) =>
    hrefWith(PATH, search, { [param]: current === value ? null : value });
  const sortHref = (key: SortKey, firstOrder: SortOrder) => {
    const order = sort.sort === key ? (sort.order === "asc" ? "desc" : "asc") : firstOrder;
    // The default view keeps both keys out of the URL.
    const isDefault = key === DEFAULT_SORT.sort && order === DEFAULT_SORT.order;
    return hrefWith(PATH, search, { sort: isDefault ? null : key, order: isDefault ? null : order });
  };
  const activeFilters = [state, setBy].filter(Boolean).length + (region.length > 0 ? 1 : 0);
  const count = (pred: (s: Source) => boolean) => <span className="tabular-nums text-muted">{sources.filter(pred).length}</span>;

  return (
    <>
      <PageHeader
        title="Regulatory sources"
        description="Choose which portals are scraped. A change applies from the next run, scheduled or manual. Rules already collected from a source you switch off are kept, but stop being updated or audited. The bundled demo rules are not affected."
      />
      {enabled === 0 && (
        <p role="status" className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          Every source is off, so scheduled runs will find nothing new and be skipped.
        </p>
      )}
      <p className="mb-3 text-sm text-muted">
        <strong className="font-medium text-foreground">Default</strong> means the source follows its SCRAPE_* environment
        flag. <strong className="font-medium text-foreground">Set here</strong> means a switch saved on this page overrides
        that flag; <strong className="font-medium text-foreground">Reset</strong> goes back to the default.
      </p>
      <FilterBar active={activeFilters}>
        <FilterChips label="Filter by state">
          {STATES.map((v) => (
            <FilterChip key={v} href={only("state", v, state)} active={state === v}>
              {v === "on" ? "On" : "Off"} {count((s) => s.enabled === (v === "on"))}
            </FilterChip>
          ))}
        </FilterChips>
        <ChipDivider />
        <FilterChips label="Filter by region">
          {regions.map((r) => (
            <FilterChip key={r} href={hrefWith(PATH, search, { region: toggleValue(region, r) })} active={region.includes(r)}>
              {r} {count((s) => s.region === r)}
            </FilterChip>
          ))}
        </FilterChips>
        <ChipDivider />
        <FilterChips label="Filter by where the switch is set">
          {SET_BY.map((v) => (
            <FilterChip key={v} href={only("set", v, setBy)} active={setBy === v}>
              {v === "here" ? "Set here" : "Default"} {count((s) => s.overridden === (v === "here"))}
            </FilterChip>
          ))}
        </FilterChips>
        <ChipDivider />
        <FilterChips label="Sort sources">
          <span className="text-sm text-muted" aria-hidden>
            Sort
          </span>
          {SORTS.map(({ key, label, firstOrder }) => {
            const active = sort.sort === key;
            const Icon = sort.order === "asc" ? ArrowUp : ArrowDown;
            return (
              <FilterChip key={key} href={sortHref(key, firstOrder)} active={active}>
                <span className="sr-only">Sort by </span>
                {label}
                {active && (
                  <>
                    <Icon className="size-3.5" aria-hidden />
                    <span className="sr-only">{sort.order === "asc" ? ", ascending" : ", descending"}</span>
                  </>
                )}
              </FilterChip>
            );
          })}
        </FilterChips>
        {hasAny(search, [...FILTER_KEYS, "sort", "order"]) && <ClearFilters href={PATH} />}
      </FilterBar>
      <p role="status" aria-live="polite" className="mb-3 text-sm text-muted">
        {shown.length === sources.length ? `${sources.length} sources` : `${shown.length} of ${sources.length} sources`}
      </p>

      {shown.length === 0 ? (
        <EmptyState title="No sources match these filters" />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {shown.map((s) => (
            <li key={s.name} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium hover:text-accent"
                  >
                    {s.label}
                    <ExternalLink className="size-3 shrink-0" aria-hidden />
                  </a>
                  <Badge tone="neutral">{s.region}</Badge>
                  {s.overridden ? (
                    <Badge tone="info" title={`Set on this page${s.updatedAt ? ` on ${formatDateTime(s.updatedAt)}` : ""}`}>
                      Set here
                    </Badge>
                  ) : (
                    <Badge tone="neutral" title="No switch saved yet; the SCRAPE_* environment flag decides">
                      Default
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted">{s.description}</p>
                <p className="mt-1 text-xs text-muted">
                  {s.rules} {s.rules === 1 ? "rule" : "rules"} collected · last checked{" "}
                  {s.lastCheckedAt ? formatDateTime(s.lastCheckedAt) : "never"}
                  {s.requires && <> · needs {s.requires}</>}
                </p>
              </div>
              <SourceSwitch
                name={s.name}
                label={s.label}
                enabled={s.enabled}
                defaultEnabled={s.defaultEnabled}
                overridden={s.overridden}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
