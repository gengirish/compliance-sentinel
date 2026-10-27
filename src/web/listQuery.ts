import { asc, desc, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";

/**
 * The shared URL contract of every list route (docs/plan-filter-sort.md §2): `sort` from a
 * per-route whitelist, `order`, `page` and `limit`, plus helpers for search and date filters.
 * Nothing from the URL reaches SQL as text: sort keys map to columns in a table the route owns.
 */

export const SORT_ORDERS = ["asc", "desc"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];
export const PAGE_LIMITS = [25, 50, 100] as const;

/** Header carrying the unpaged row count; the body stays a plain array for older clients. */
export const TOTAL_HEADER = "x-total-count";

export function sortQuery<K extends readonly [string, ...string[]]>(keys: K, defaults: { sort: K[number]; order: SortOrder }) {
  return {
    sort: z.enum(keys, { message: `sort must be one of ${keys.join(", ")}` }).default(defaults.sort as never),
    order: z.enum(SORT_ORDERS, { message: "order must be asc or desc" }).default(defaults.order),
  };
}

export function pageQuery(defaultLimit: (typeof PAGE_LIMITS)[number]) {
  return {
    page: z.coerce.number().int().positive({ message: "page must be a positive integer" }).default(1),
    limit: z.coerce
      .number()
      .refine((n) => (PAGE_LIMITS as readonly number[]).includes(n), { message: `limit must be one of ${PAGE_LIMITS.join(", ")}` })
      .default(defaultLimit),
  };
}

/** `?q=`: trimmed, at most 100 characters; empty means no search. */
export const searchQuery = z
  .string()
  .trim()
  .max(100, { message: "q must be at most 100 characters" })
  .optional()
  .transform((v) => (v ? v : undefined));

/** `?from=` / `?to=` as YYYY-MM-DD (UTC, inclusive). */
export const dateQuery = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "expected a date as YYYY-MM-DD" })
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), { message: "not a valid date" })
  .optional();

/** Start of `day` and start of the day after it, in UTC, for an inclusive `from`..`to` range. */
export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}
export function dayAfter(day: string): Date {
  return new Date(dayStart(day).getTime() + 24 * 60 * 60 * 1000);
}

/** `%term%` for ILIKE, with the user's `%`, `_` and `\` taken literally. */
export function likeContains(term: string): string {
  return `%${escapeLike(term)}%`;
}
export function likePrefix(term: string): string {
  return `${escapeLike(term)}%`;
}
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * ORDER BY for a whitelisted key, with a tie-breaker so pages are stable. Values in `columns`
 * are columns or SQL expressions the route defines, never URL text.
 */
export function orderBy<K extends string>(
  columns: Record<K, AnyColumn | SQL>,
  sort: K,
  order: SortOrder,
  tieBreaker: AnyColumn,
): SQL[] {
  const dir = order === "asc" ? asc : desc;
  return [dir(columns[sort]), dir(tieBreaker)];
}

export function pageOffset(page: number, limit: number): number {
  return (page - 1) * limit;
}

export function setTotal(c: Context, total: number): void {
  c.header(TOTAL_HEADER, String(total));
}

/** `CASE` ranking of a text column by a fixed order, e.g. severity with critical first. */
export function rank(column: AnyColumn, values: readonly string[]): SQL {
  const cases = values.map((v, i) => sql`WHEN ${v} THEN ${i}`);
  return sql`CASE ${column} ${sql.join(cases, sql` `)} ELSE ${values.length} END`;
}
