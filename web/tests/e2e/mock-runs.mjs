// `GET /runs` of the e2e mock API: the same filters, sorts, paging and x-total-count as the
// real route (src/web/server.ts), over the mock's fixture runs.

const STATUSES = ["running", "completed", "skipped", "failed"];
const TRIGGERS = ["cron", "manual", "install", "pull_request", "push"];
const SORTS = ["started", "duration", "cost", "violations", "critical"];
const LIMITS = [25, 50, 100];
const DAY_MS = 24 * 60 * 60 * 1000;

const zeroCounts = () => ({
  total: 0,
  byStatus: { compliant: 0, violation: 0, needs_review: 0 },
  bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
  criticalViolations: 0,
});

/**
 * 27 runs older than `base`, one a day going back, so the list has enough to page. Ids start
 * at 40: clear of the ids the tests name (#1-#3) and of the runs they queue (#4 up), and none
 * starts with 1, 2 or 3, so a name match on "#1" or /#2/ still finds one row. Two repos, so
 * the repository select shows.
 */
export function olderRuns(base) {
  return Array.from({ length: 27 }, (_, i) => {
    const startedAt = new Date(Date.parse(base.startedAt) - (i + 1) * DAY_MS);
    const status = i % 5 === 3 ? "failed" : i % 5 === 4 ? "skipped" : "completed";
    const counts = zeroCounts();
    if (status === "completed") {
      const violation = i % 4;
      const critical = i % 3 === 0 && violation > 0 ? 1 : 0;
      Object.assign(counts, {
        total: violation + 1,
        byStatus: { compliant: 1, violation, needs_review: 0 },
        bySeverity: { critical, high: violation - critical, medium: 0, low: 1 },
        criticalViolations: critical,
      });
    }
    return {
      ...base,
      id: 40 + i,
      repoId: 7 + (i % 2),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + (20 + ((i * 37) % 90)) * 1000).toISOString(),
      status,
      trigger: ["cron", "cron", "pull_request", "manual", "push"][i % 5],
      reportUrl: status === "completed" ? base.reportUrl : null,
      costUsd: Math.round(((i * 7) % 13) * 1.5) / 100,
      error: status === "failed" ? "The analyst returned malformed output." : null,
      note: status === "skipped" ? "No new or amended rules since the last check, so there was nothing to audit." : null,
      counts,
    };
  });
}

const sortValue = {
  started: (r) => Date.parse(r.startedAt),
  duration: (r) => (r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null),
  cost: (r) => r.costUsd,
  violations: (r) => r.counts?.byStatus.violation ?? 0,
  critical: (r) => r.counts?.criticalViolations ?? 0,
};

/** `{ status, headers, body }` for `GET /runs` with these search params over `runs`. */
export function listRuns(runs, params) {
  const issues = [];
  const list = (key, allowed) => {
    const values = [...new Set((params.get(key) ?? "").split(",").filter(Boolean))];
    if (values.some((v) => !allowed.includes(v))) issues.push({ path: key, message: `expected one of ${allowed.join(", ")}` });
    return values;
  };
  const date = (key) => {
    const v = params.get(key);
    if (v !== null && !(/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) {
      issues.push({ path: key, message: "expected a date as YYYY-MM-DD" });
    }
    return v ?? undefined;
  };
  const oneOf = (key, allowed, fallback) => {
    const v = params.get(key) ?? fallback;
    if (!allowed.includes(v)) issues.push({ path: key, message: `${key} must be one of ${allowed.join(", ")}` });
    return v;
  };
  const status = list("status", STATUSES);
  const trigger = list("trigger", TRIGGERS);
  const from = date("from");
  const to = date("to");
  const critical = params.get("critical") === "1" || params.get("critical") === "true";
  const repo = params.get("repo") === null ? undefined : Number(params.get("repo"));
  if (repo !== undefined && !(Number.isInteger(repo) && repo > 0)) issues.push({ path: "repo", message: "repo must be a positive integer" });
  const sort = oneOf("sort", SORTS, "started");
  const order = oneOf("order", ["asc", "desc"], "desc");
  const page = Number(params.get("page") ?? 1);
  if (!(Number.isInteger(page) && page > 0)) issues.push({ path: "page", message: "page must be a positive integer" });
  const limit = Number(params.get("limit") ?? 25);
  if (!LIMITS.includes(limit)) issues.push({ path: "limit", message: `limit must be one of ${LIMITS.join(", ")}` });
  if (issues.length) return { status: 400, headers: {}, body: { error: "invalid request", issues } };

  const matching = runs.filter(
    (r) =>
      (!status.length || status.includes(r.status)) &&
      (!trigger.length || trigger.includes(r.trigger)) &&
      (!from || Date.parse(r.startedAt) >= Date.parse(`${from}T00:00:00Z`)) &&
      (!to || Date.parse(r.startedAt) < Date.parse(`${to}T00:00:00Z`) + DAY_MS) &&
      (!critical || (r.counts?.criticalViolations ?? 0) > 0) &&
      (repo === undefined || r.repoId === repo),
  );
  const dir = order === "asc" ? 1 : -1;
  const value = sortValue[sort];
  matching.sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    // Like the API: a run without a duration sorts last either way, and ties go by id.
    if (x === null || y === null) return x === y ? dir * (a.id - b.id) : x === null ? 1 : -1;
    return x !== y ? dir * (x - y) : dir * (a.id - b.id);
  });
  return {
    status: 200,
    headers: { "x-total-count": String(matching.length) },
    body: matching.slice((page - 1) * limit, page * limit),
  };
}
