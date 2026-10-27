/**
 * The URL is the state of every list screen (docs/plan-filter-sort.md §2): pages read their
 * `searchParams` with these helpers and build links that change one parameter and keep the
 * rest. Values the API would reject are dropped here, so an old or hand-edited URL shows the
 * default view instead of an error page.
 */

export type SearchParams = Record<string, string | string[] | undefined>;

export const PAGE_LIMITS = [25, 50, 100] as const;
export type SortOrder = "asc" | "desc";

function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** A comma list filtered to the allowed values, in the order given. */
export function pickList<T extends string>(raw: string | string[] | undefined, allowed: readonly T[]): T[] {
  const values = (first(raw) ?? "").split(",");
  return allowed.filter((v) => values.includes(v));
}

export function pickOne<T extends string>(raw: string | string[] | undefined, allowed: readonly T[]): T | undefined {
  const v = first(raw);
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** `q`, trimmed and capped as the API expects; undefined when empty. */
export function pickSearch(raw: string | string[] | undefined): string | undefined {
  const v = first(raw)?.trim().slice(0, 100);
  return v ? v : undefined;
}

export function pickDate(raw: string | string[] | undefined): string | undefined {
  const v = first(raw);
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : undefined;
}

export function pickPage(raw: string | string[] | undefined): number {
  const n = Number(first(raw));
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export function pickLimit(raw: string | string[] | undefined, fallback: (typeof PAGE_LIMITS)[number]): number {
  const n = Number(first(raw));
  return (PAGE_LIMITS as readonly number[]).includes(n) ? n : fallback;
}

export type SortState<K extends string> = { sort: K; order: SortOrder; isDefault: boolean };

export function pickSort<K extends string>(
  params: SearchParams,
  keys: readonly K[],
  defaults: { sort: K; order: SortOrder },
): SortState<K> {
  const sort = pickOne(params.sort, keys) ?? defaults.sort;
  const order = pickOne(params.order, ["asc", "desc"] as const) ?? defaults.order;
  return { sort, order, isDefault: sort === defaults.sort && order === defaults.order };
}

/** Only the defined string values, as URLSearchParams wants them. */
export function toQuery(params: SearchParams): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    const s = first(v);
    if (s !== undefined && s !== "") q.set(k, s);
  }
  return q;
}

/**
 * `path` with `params` changed by `changes`; a null or empty value removes the key. Any change
 * other than the page itself goes back to page 1, since the old page may no longer exist.
 */
export function hrefWith(path: string, params: SearchParams, changes: Record<string, string | number | null | undefined>): string {
  const q = toQuery(params);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined || v === "") q.delete(k);
    else q.set(k, String(v));
  }
  if (!("page" in changes)) q.delete("page");
  if (q.get("page") === "1") q.delete("page");
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Adds or removes one value of a comma-list parameter. */
export function toggleValue(list: readonly string[], value: string): string | null {
  const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  return next.length ? next.join(",") : null;
}

/** True when any of `keys` is set, for showing "Clear". */
export function hasAny(params: SearchParams, keys: readonly string[]): boolean {
  return keys.some((k) => first(params[k]) !== undefined && first(params[k]) !== "");
}
