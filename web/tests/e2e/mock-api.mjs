// Stand-in for the Sentinel API during e2e runs: fixed fixtures, same routes and token check.
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_API_PORT ?? 8099);
const TOKEN = "e2e-token";

const counts = {
  total: 3,
  byStatus: { compliant: 1, violation: 2, needs_review: 0 },
  bySeverity: { critical: 1, high: 1, medium: 1, low: 0 },
  criticalViolations: 1,
};
const run = {
  id: 1,
  startedAt: "2026-10-12T03:06:38.894Z",
  finishedAt: "2026-10-12T03:07:24.635Z",
  status: "completed",
  trigger: "manual",
  rulesInScope: [1],
  reportUrl: "/tmp/run-1.html",
  costUsd: 0,
  error: null,
  counts,
};
const noCounts = {
  total: 0,
  byStatus: { compliant: 0, violation: 0, needs_review: 0 },
  bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
  criticalViolations: 0,
};
// A run the stale-run watchdog marked failed after the worker died mid-run.
const timedOut = {
  ...run,
  id: 2,
  status: "failed",
  reportUrl: null,
  error: "Timed out: still running after 30 minutes. The worker most likely restarted or crashed mid-run.",
  counts: noCounts,
};
const skipped = {
  ...run,
  id: 3,
  status: "skipped",
  rulesInScope: [],
  reportUrl: null,
  note: "No new or amended rules since the last check, so there was nothing to audit.",
  counts: noCounts,
};
const runs = [skipped, timedOut, run];

// A triggered run shows as running, then completes a few seconds later, like the real worker.
const RUN_SECONDS = 10;
const queueRun = () => {
  const startedAt = new Date().toISOString();
  runs.unshift({ ...run, id: runs[0].id + 1, startedAt, finishedAt: null, status: "running", reportUrl: null, counts: noCounts });
};
const live = (r) => {
  if (r.status !== "running" || Date.now() - Date.parse(r.startedAt) < RUN_SECONDS * 1000) return r;
  return { ...r, status: "completed", finishedAt: new Date().toISOString(), counts };
};
const rule = { id: 1, title: "Demo Safeguards Rule", url: "https://example.com/rule", externalId: "DEMO-1" };
const finding = (id, status, severity, obligation) => ({
  id,
  runId: 1,
  ruleId: 1,
  obligation,
  status,
  severity,
  rationale: `Rationale for ${obligation}.`,
  citationChunkIds: [100 + id],
  evidence: [{ path: "src/auth/session.ts", start_line: 10 + id, end_line: 14 + id, excerpt: "const ttl = 0;" }],
  rule,
  citations: [{ id: 100 + id, sectionRef: "§ 314.4(c)", excerpt: "Encrypt all customer information." }],
});
const findings = [
  finding(1, "violation", "critical", "Encrypt customer data at rest"),
  finding(2, "violation", "high", "Expire sessions after inactivity"),
  finding(3, "compliant", "medium", "Log access to customer records"),
];

const source = (name, label, region, enabled, requires = null) => ({
  name,
  label,
  region,
  description: `${label} test source.`,
  requires,
  kind: "api",
  url: `https://example.com/${name}`,
  enabled,
  defaultEnabled: enabled,
  overridden: false,
  updatedAt: null,
  lastCheckedAt: null,
  rules: 0,
});
const sources = [source("federal-register", "Federal Register", "US", true), source("mas", "MAS", "SG", false, "Chromium (Playwright) and pdftotext")];

const routes = {
  "GET /settings/sources": () => sources,
  "GET /stats": () => ({ latestRun: live(runs[0]), latestCompletedRun: run, totals: { rules: 1, runs: 1 } }),
  "GET /runs": () => runs.map(live),
  "GET /rules": () => [
    {
      ...rule,
      effectiveDate: "2026-01-01",
      firstSeenAt: run.startedAt,
      lastChangedAt: run.startedAt,
      source: { name: "fixture-demo", kind: "fixture" },
      lastAuditedRunId: 1,
    },
  ],
  "POST /runs": () => {
    queueRun();
    return [202, { jobId: "e2e-job", demo: true }];
  },
};

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/health") return send(200, { ok: true });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });

  const runMatch = url.pathname.match(/^\/runs\/(\d+)$/);
  if (req.method === "GET" && runMatch) {
    const found = runs.find((r) => r.id === Number(runMatch[1]));
    return found ? send(200, live(found)) : send(404, { error: "run not found" });
  }
  if (req.method === "GET" && /^\/runs\/\d+\/findings$/.test(url.pathname) && url.pathname !== "/runs/1/findings") {
    return send(200, []);
  }
  if (req.method === "GET" && url.pathname === "/runs/1/findings") {
    const status = url.searchParams.get("status")?.split(",");
    const severity = url.searchParams.get("severity")?.split(",");
    return send(
      200,
      findings.filter((f) => (!status || status.includes(f.status)) && (!severity || severity.includes(f.severity))),
    );
  }
  const sourceMatch = url.pathname.match(/^\/settings\/sources\/([\w-]+)$/);
  if (req.method === "PUT" && sourceMatch) {
    const found = sources.find((s) => s.name === sourceMatch[1]);
    if (!found) return send(404, { error: "unknown source" });
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const { enabled } = JSON.parse(raw);
      Object.assign(found, enabled === null ? { enabled: found.defaultEnabled, overridden: false } : { enabled, overridden: true });
      send(200, found);
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/reports/1") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end("<h1>Demo report</h1>");
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(404, { error: "not found" });
  const out = handler();
  return Array.isArray(out) && typeof out[0] === "number" ? send(out[0], out[1]) : send(200, out);
}).listen(PORT, "127.0.0.1", () => console.log(`mock api on ${PORT}`));
