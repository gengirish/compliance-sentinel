// The findings routes of the e2e mock API, with the filters and sort of GET /runs/:id/findings
// (docs/plan-filter-sort.md §3 F2). Run 1 keeps the three findings dashboard.spec relies on; run
// FINDINGS_RUN_ID has enough rules, paths and severities for findings.spec. It is not in the runs list.

export const FINDINGS_RUN_ID = 90;

const SEVERITIES = ["critical", "high", "medium", "low"];
const STATUSES = ["compliant", "violation", "needs_review"];
const SORTS = ["severity", "status", "rule", "path"];
// Higher is worse, so descending is the worst first, as in the API.
const severityWeight = (f) => ["low", "medium", "high", "critical"].indexOf(f.severity);
const statusWeight = (f) => ["compliant", "needs_review", "violation"].indexOf(f.status);

const rule = (id, title) => ({ id, title, url: `https://example.com/rules/${id}`, externalId: `R-${id}` });
const access = rule(11, "Access Control Rule");
const encryption = rule(12, "Encryption Rule");
const logging = rule(13, "Logging Rule");

let nextId = 900;
const finding = (r, status, severity, obligation, path) => {
  const id = nextId++;
  return {
    id,
    runId: FINDINGS_RUN_ID,
    ruleId: r.id,
    obligation,
    status,
    severity,
    rationale: `Rationale for ${obligation.toLowerCase()}.`,
    citationChunkIds: [],
    evidence: path ? [{ path, start_line: 3, end_line: 9, excerpt: "// code" }] : [],
    rule: r,
    citations: [],
  };
};

const findings = [
  finding(encryption, "violation", "critical", "Encrypt card numbers at rest", "src/payments/card.ts"),
  finding(access, "violation", "high", "Require MFA for admin access", "src/auth/admin.ts"),
  finding(access, "needs_review", "critical", "Restrict refund approvals", "src/payments/refund.ts"),
  finding(logging, "compliant", "medium", "Log payment attempts", "src/payments/log.ts"),
  finding(logging, "violation", "medium", "Retain audit logs for a year", "infra/logging.tf"),
  finding(encryption, "compliant", "low", "Use TLS for API calls", "src/api/client.ts"),
  finding(encryption, "needs_review", "high", "Rotate encryption keys", null),
  finding(access, "violation", "low", "Expire idle sessions", "src/auth/session.ts"),
];

const tally = (key, values) => Object.fromEntries(values.map((v) => [v, findings.filter((f) => f[key] === v).length]));
const run = {
  id: FINDINGS_RUN_ID,
  startedAt: "2026-10-20T03:00:00.000Z",
  finishedAt: "2026-10-20T03:01:00.000Z",
  status: "completed",
  trigger: "manual",
  rulesInScope: [11, 12, 13],
  reportUrl: null,
  costUsd: 0,
  error: null,
  counts: {
    total: findings.length,
    byStatus: tally("status", STATUSES),
    bySeverity: tally("severity", SEVERITIES),
    criticalViolations: findings.filter((f) => f.status === "violation" && f.severity === "critical").length,
  },
};

/** The list filtered and sorted as the API would, or a 400 for a value it would reject. */
function listFindings(list, params) {
  const csv = (key, allowed) => {
    const values = (params.get(key) ?? "").split(",").filter(Boolean);
    return values.every((v) => allowed.includes(v)) ? values : null;
  };
  const status = csv("status", STATUSES);
  const severity = csv("severity", SEVERITIES);
  const rule = params.get("rule");
  const path = params.get("path")?.trim();
  const q = params.get("q")?.trim().toLowerCase();
  const sort = params.get("sort") ?? "severity";
  const order = params.get("order") ?? "desc";
  if (!status || !severity || !SORTS.includes(sort) || !["asc", "desc"].includes(order) || (rule && !/^[1-9]\d*$/.test(rule))) {
    return [400, { error: "invalid request" }];
  }

  const rows = list.filter(
    (f) =>
      (!status.length || status.includes(f.status)) &&
      (!severity.length || severity.includes(f.severity)) &&
      (!rule || f.ruleId === Number(rule)) &&
      (!path || f.evidence.some((e) => e.path.startsWith(path))) &&
      (!q || f.obligation.toLowerCase().includes(q) || f.rationale.toLowerCase().includes(q)),
  );

  const dir = order === "asc" ? 1 : -1;
  const worstFirst = (a, b) => severityWeight(b) - severityWeight(a) || statusWeight(b) - statusWeight(a);
  const firstPath = (f) => f.evidence[0]?.path;
  const compare = {
    severity: (a, b) => dir * (severityWeight(a) - severityWeight(b) || statusWeight(a) - statusWeight(b)),
    status: (a, b) => dir * (statusWeight(a) - statusWeight(b) || severityWeight(a) - severityWeight(b)),
    rule: (a, b) => dir * a.rule.title.localeCompare(b.rule.title) || worstFirst(a, b),
    // No evidence sorts last in either direction.
    path: (a, b) =>
      (firstPath(a) === undefined) - (firstPath(b) === undefined) ||
      dir * (firstPath(a) ?? "").localeCompare(firstPath(b) ?? "") ||
      worstFirst(a, b),
  }[sort];
  return [200, [...rows].sort((a, b) => compare(a, b) || a.id - b.id)];
}

/** `[status, body]` for the findings routes, or undefined when the request is not one of them. */
export function routeFindings(method, url, runOneFindings) {
  if (method !== "GET") return undefined;
  if (url.pathname === `/runs/${FINDINGS_RUN_ID}`) return [200, run];
  const match = url.pathname.match(/^\/runs\/(\d+)\/findings$/);
  if (!match) return undefined;
  const id = Number(match[1]);
  // Other runs have no findings, as before.
  return listFindings(id === 1 ? runOneFindings : id === FINDINGS_RUN_ID ? findings : [], url.searchParams);
}
