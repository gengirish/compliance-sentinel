import { z } from "zod";
import { RUN_STATUSES, TRIGGERS } from "../db/schema.js";
import { SEVERITIES, STATUSES } from "../graph/types.js";
import { dateQuery, pageQuery, searchQuery, sortQuery } from "./listQuery.js";

/** Request inputs for the HTTP API. Every route parses its params and query through one of these. */

export const RunIdParams = z.object({
  id: z.coerce.number().int().positive({ message: "run id must be a positive integer" }),
});

/** `?flag=1`, `true`, `0` or `false`; absent means false. */
const flag = z
  .enum(["1", "true", "0", "false"], { message: "expected 1, true, 0 or false" })
  .optional()
  .transform((v) => v === "1" || v === "true");

/** `?key=a,b` against a fixed set. Unknown values are rejected rather than dropped, so typos surface. */
export function commaList<T extends readonly [string, ...string[]]>(allowed: T) {
  return z
    .string()
    .optional()
    .transform((raw) => [...new Set((raw ?? "").split(",").filter(Boolean))])
    .pipe(z.array(z.enum(allowed)));
}

export const TriggerRunQuery = z.object({ demo: flag });

export const FINDING_SORTS = ["severity", "status", "rule", "path"] as const;
export const RUN_SORTS = ["started", "duration", "cost", "violations", "critical"] as const;
export type RunSort = (typeof RUN_SORTS)[number];

/** `GET /runs`: with no parameters, the newest 25 runs. */
export const ListRunsQuery = z
  .object({
    counts: flag,
    status: commaList(RUN_STATUSES),
    trigger: commaList(TRIGGERS),
    from: dateQuery,
    to: dateQuery,
    /** Only runs with at least one critical violation. */
    critical: flag,
    repo: z.coerce.number().int().positive({ message: "repo must be a positive integer" }).optional(),
    ...sortQuery(RUN_SORTS, { sort: "started", order: "desc" }),
    ...pageQuery(25),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { path: ["to"], message: "to must not be before from" });

export const FindingsQuery = z.object({
  status: commaList(STATUSES),
  severity: commaList(SEVERITIES),
  rule: z.coerce.number().int().positive({ message: "rule must be a positive integer" }).optional(),
  /** Evidence path prefix, such as `src/payments`. */
  path: z
    .string()
    .trim()
    .max(200, { message: "path must be at most 200 characters" })
    .optional()
    .transform((v) => (v ? v : undefined)),
  q: searchQuery,
  // Severity descending is the worst first: critical, then violation before needs review.
  ...sortQuery(FINDING_SORTS, { sort: "severity", order: "desc" }),
});

export const RULE_SORTS = ["changed", "first_seen", "effective", "title", "source"] as const;

/**
 * `?source=a,b` by source name. Checked for shape only, not against the sources table: the set
 * is open (fixture runs add `<name>-demo` rows), and a link to a source with no rows yet in this
 * database should show an empty list rather than an error. An unknown name matches nothing.
 */
const sourceList = z
  .string()
  .optional()
  .transform((raw) => [...new Set((raw ?? "").split(",").filter(Boolean))])
  .pipe(z.array(z.string().regex(/^[a-z0-9-]{1,64}$/, { message: "source names are lowercase letters, digits and dashes" })));

export const ListRulesQuery = z
  .object({
    q: searchQuery,
    source: sourceList,
    audited: z.enum(["yes", "no"], { message: "audited must be yes or no" }).optional(),
    /** Last changed within this many days. */
    changed: z.enum(["7", "30", "90"], { message: "changed must be 7, 30 or 90" }).optional().transform((v) => (v ? Number(v) : undefined)),
    from: dateQuery,
    to: dateQuery,
    ...sortQuery(RULE_SORTS, { sort: "changed", order: "desc" }),
    ...pageQuery(50),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "from must not be after to", path: ["to"] });

/** `true`/`false` switches the source; `null` hands it back to its SCRAPE_* flag. */
export const SourceSettingBody = z.strictObject({ enabled: z.boolean().nullable() });

export const SubscribeBody = z.strictObject({ email: z.email({ message: "expected an email address" }).max(254) });

export const SubscriberTokenBody = z.strictObject({ token: z.string().min(16).max(128) });

export type RequestIssue ={ path: string; message: string };

export function describeIssues(error: z.ZodError): RequestIssue[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
