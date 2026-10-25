import { z } from "zod";
import { SEVERITIES, STATUSES } from "../graph/types.js";

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
function commaList<T extends readonly [string, ...string[]]>(allowed: T) {
  return z
    .string()
    .optional()
    .transform((raw) => [...new Set((raw ?? "").split(",").filter(Boolean))])
    .pipe(z.array(z.enum(allowed)));
}

export const TriggerRunQuery = z.object({ demo: flag });

export const ListRunsQuery = z.object({ counts: flag });

export const FindingsQuery = z.object({
  status: commaList(STATUSES),
  severity: commaList(SEVERITIES),
});

export type RequestIssue = { path: string; message: string };

export function describeIssues(error: z.ZodError): RequestIssue[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
