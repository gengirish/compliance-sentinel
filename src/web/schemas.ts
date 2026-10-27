import { z } from "zod";
import { RUN_STATUSES, TRIGGERS } from "../db/schema.js";
import { SEVERITIES, STATUSES } from "../graph/types.js";
import { dateQuery, pageQuery, sortQuery } from "./listQuery.js";

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
});

/** `true`/`false` switches the source; `null` hands it back to its SCRAPE_* flag. */
export const SourceSettingBody = z.strictObject({ enabled: z.boolean().nullable() });

export type RequestIssue = { path: string; message: string };

export function describeIssues(error: z.ZodError): RequestIssue[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
