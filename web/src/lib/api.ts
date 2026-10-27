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
export const TRIGGERS = ["cron", "manual", "install", "pull_request", "push"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const TRIGGER_LABEL: Record<Trigger, string> = {
  cron: "Scheduled",
  manual: "Manual",
  install: "Installed",
  pull_request: "Pull request",
  push: "Push",
};

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
  trigger: z.enum(TRIGGERS),
  // Optional so the dashboard keeps working against an API deployed before tenancy.
  repoId: z.number().nullable().optional(),
  headSha: z.string().nullable().optional(),
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

const RuleSource = z.object({ name: z.string(), kind: z.string(), rules: z.number() });

const Source = z.object({
  name: z.string(),
  label: z.string(),
  region: z.string(),
  description: z.string(),
  requires: z.string().nullable(),
  kind: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  defaultEnabled: z.boolean(),
  overridden: z.boolean(),
  updatedAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  rules: z.number(),
});

export type Run = z.infer<typeof Run>;
export type Source = z.infer<typeof Source>;
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

/** A page of a list route: the rows, and the unpaged count from the `x-total-count` header. */
export type ListPage<T> = { items: T[]; total: number };

export async function getList<T>(path: string, schema: z.ZodType<T>): Promise<ListPage<T>> {
  const res = await apiFetch(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `Sentinel API returned ${res.status}`, res.status);
  }
  const items = z.array(schema).parse(await res.json());
  // An API from before paging sends no header; then the page is everything there is.
  const header = Number(res.headers.get("x-total-count"));
  return { items, total: Number.isFinite(header) && res.headers.has("x-total-count") ? header : items.length };
}

/** `/path?a=1&b=2` from a query object, leaving out empty values. */
export function withQuery(path: string, query: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

export const api = {
  stats: () => getJson("/stats", Stats),
  runs: () => getJson("/runs?counts=1", z.array(Run)),
  /** Just id and status of the recent runs, for cheap polling. */
  runStatuses: async () => (await getJson("/runs", z.array(Run))).map(({ id, status }) => ({ id, status })),
  run: (id: number) => getJson(`/runs/${id}`, Run),
  findings: (id: number, filter: { status?: string[]; severity?: string[] } = {}) => {
    const q = new URLSearchParams();
    if (filter.status?.length) q.set("status", filter.status.join(","));
    if (filter.severity?.length) q.set("severity", filter.severity.join(","));
    const qs = q.toString();
    return getJson(`/runs/${id}/findings${qs ? `?${qs}` : ""}`, z.array(Finding));
  },
  /** One page of tracked rules; `query` holds the list parameters of `GET /rules` (see the rules page). */
  rulesPage: (query: Record<string, string | number | undefined>) => getList(withQuery("/rules", query), Rule),
  /** The sources that have rules, for the rules page's source filter. */
  ruleSources: () => getJson("/rules/sources", z.array(RuleSource)),
  /** The scraper switches. Only the operator may read them; the API answers 403 to anyone else. */
  sources: () => getJson("/settings/sources", z.array(Source)),
};
