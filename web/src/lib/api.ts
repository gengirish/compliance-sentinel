import "server-only";
import { z } from "zod";

/**
 * Server-side client for the Compliance Sentinel API. The bearer token stays on the
 * server: pages call these from server components, and the browser only ever talks
 * to this app's own route handlers.
 */

export const FINDING_STATUSES = ["violation", "needs_review", "compliant"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export type Severity = (typeof SEVERITIES)[number];

const Counts = z.object({
  total: z.number(),
  byStatus: z.record(z.enum(FINDING_STATUSES), z.number()),
  bySeverity: z.record(z.enum(SEVERITIES), z.number()),
  criticalViolations: z.number(),
});

const Run = z.object({
  id: z.number(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(["running", "completed", "skipped", "failed"]),
  trigger: z.enum(["cron", "manual"]),
  rulesInScope: z.array(z.number()),
  reportUrl: z.string().nullable(),
  costUsd: z.number(),
  error: z.string().nullable(),
  // Optional so the dashboard keeps working against an API deployed before the column existed.
  note: z.string().nullable().optional(),
  counts: Counts.optional(),
});

const Stats = z.object({
  latestRun: Run.nullable(),
  latestCompletedRun: Run.nullable(),
  totals: z.object({ rules: z.number(), runs: z.number() }),
});

const Finding = z.object({
  id: z.number(),
  runId: z.number(),
  ruleId: z.number(),
  obligation: z.string(),
  status: z.enum(FINDING_STATUSES),
  severity: z.enum(SEVERITIES),
  rationale: z.string(),
  citationChunkIds: z.array(z.number()),
  evidence: z.array(
    z.object({ path: z.string(), start_line: z.number(), end_line: z.number(), excerpt: z.string() }),
  ),
  rule: z.object({ id: z.number(), title: z.string(), url: z.string(), externalId: z.string() }),
  citations: z.array(z.object({ id: z.number(), sectionRef: z.string().nullable(), excerpt: z.string() })),
});

const Rule = z.object({
  id: z.number(),
  externalId: z.string(),
  title: z.string(),
  url: z.string(),
  effectiveDate: z.string().nullable(),
  firstSeenAt: z.string(),
  lastChangedAt: z.string(),
  source: z.object({ name: z.string(), kind: z.string() }),
  lastAuditedRunId: z.number().nullable(),
});

export type Run = z.infer<typeof Run>;
export type Stats = z.infer<typeof Stats>;
export type Finding = z.infer<typeof Finding>;
export type Rule = z.infer<typeof Rule>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function apiConfig() {
  return {
    url: (process.env.SENTINEL_API_URL ?? "http://localhost:8080").replace(/\/$/, ""),
    token: process.env.SENTINEL_API_TOKEN ?? "",
  };
}

/** Raw call to the API with the bearer token attached. Callers handle the response. */
export async function apiFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { url, token } = apiConfig();
  const { timeoutMs = 10_000, ...rest } = init;
  try {
    return await fetch(`${url}${path}`, {
      ...rest,
      headers: { ...rest.headers, authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ApiError(`Cannot reach the Sentinel API at ${url} (${(err as Error).message})`);
  }
}

async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await apiFetch(path);
  if (res.status === 404) throw new ApiError("Not found", 404);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `Sentinel API returned ${res.status}`, res.status);
  }
  return schema.parse(await res.json());
}

export const api = {
  stats: () => getJson("/stats", Stats),
  runs: () => getJson("/runs?counts=1", z.array(Run)),
  run: (id: number) => getJson(`/runs/${id}`, Run),
  findings: (id: number, filter: { status?: string[]; severity?: string[] } = {}) => {
    const q = new URLSearchParams();
    if (filter.status?.length) q.set("status", filter.status.join(","));
    if (filter.severity?.length) q.set("severity", filter.severity.join(","));
    const qs = q.toString();
    return getJson(`/runs/${id}/findings${qs ? `?${qs}` : ""}`, z.array(Finding));
  },
  rules: () => getJson("/rules", z.array(Rule)),
};
