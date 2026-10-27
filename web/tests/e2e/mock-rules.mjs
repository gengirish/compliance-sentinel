// `GET /rules` and `GET /rules/sources` for the e2e mock API: enough rules (61) to page at 50,
// with the same filters, sorts and x-total-count header as the real route.

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-12T03:06:38.894Z");
const iso = (ms) => new Date(ms).toISOString();

const SOURCES = [
  { name: "federal-register", kind: "api", label: "Federal Register", prefix: "FR" },
  { name: "esma", kind: "api", label: "ESMA", prefix: "ESMA" },
  { name: "fca", kind: "api", label: "FCA", prefix: "FCA" },
];

// The rule the dashboard tests look for comes first under the default sort (last changed).
const rules = [
  {
    id: 1,
    externalId: "DEMO-1",
    title: "Demo Safeguards Rule",
    url: "https://example.com/rule",
    effectiveDate: "2026-01-01",
    firstSeenAt: iso(NOW - 400 * 24 * HOUR),
    lastChangedAt: iso(NOW),
    source: { name: "fixture-demo", kind: "fixture" },
    lastAuditedRunId: 1,
  },
];
for (let id = 2; id <= 60; id++) {
  const s = SOURCES[id % SOURCES.length];
  rules.push({
    id,
    externalId: `${s.prefix}-${1000 + id}`,
    title: `${s.label} notice ${String(id).padStart(2, "0")}`,
    url: `https://example.com/${s.name}/${id}`,
    effectiveDate: id % 7 === 0 ? null : `2025-${String((id % 12) + 1).padStart(2, "0")}-${String((id % 28) + 1).padStart(2, "0")}`,
    firstSeenAt: iso(NOW - id * 24 * HOUR),
    lastChangedAt: iso(NOW - id * HOUR),
    source: { name: s.name, kind: s.kind },
    lastAuditedRunId: id % 4 === 0 ? 1 : null,
  });
}
rules.push({
  id: 61,
  externalId: "ESMA-MICA-7",
  title: "MiCA crypto-asset guidelines",
  url: "https://example.com/esma/mica",
  effectiveDate: "2024-12-30",
  firstSeenAt: iso(NOW - 900 * 24 * HOUR),
  lastChangedAt: iso(NOW - 2000 * HOUR),
  source: { name: "esma", kind: "api" },
  lastAuditedRunId: null,
});

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SORTS = {
  changed: (r) => r.lastChangedAt,
  first_seen: (r) => r.firstSeenAt,
  effective: (r) => (r.effectiveDate && ISO_DAY.test(r.effectiveDate) ? r.effectiveDate : null),
  title: (r) => r.title,
  source: (r) => r.source.name,
};

function listRules(params) {
  const q = params.get("q")?.trim().toLowerCase();
  const source = params.get("source")?.split(",").filter(Boolean) ?? [];
  const audited = params.get("audited");
  const changed = Number(params.get("changed")) || 0;
  const from = params.get("from");
  const to = params.get("to");
  const sort = params.get("sort") ?? "changed";
  const order = params.get("order") ?? "desc";
  const page = Number(params.get("page") ?? 1);
  const limit = Number(params.get("limit") ?? 50);
  if (!SORTS[sort]) return { status: 400, body: { error: "invalid request", issues: [{ path: "sort", message: "unknown sort" }] } };

  const key = SORTS[sort];
  const dir = order === "asc" ? 1 : -1;
  const matched = rules
    .filter((r) => !q || r.title.toLowerCase().includes(q) || r.externalId.toLowerCase().includes(q))
    .filter((r) => !source.length || source.includes(r.source.name))
    .filter((r) => !audited || (audited === "yes") === (r.lastAuditedRunId !== null))
    .filter((r) => !changed || Date.parse(r.lastChangedAt) >= NOW - changed * 24 * HOUR)
    .filter((r) => !from || (SORTS.effective(r) ?? "") >= from)
    .filter((r) => !to || (SORTS.effective(r) !== null && SORTS.effective(r) <= to))
    .sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      // Undated rules sort last either way, as in the real route.
      if (x === null || y === null) return x === y ? a.id - b.id : x === null ? 1 : -1;
      return (x < y ? -1 : x > y ? 1 : a.id - b.id) * dir;
    });
  return { status: 200, body: matched.slice((page - 1) * limit, page * limit), total: matched.length };
}

function listSources() {
  const counts = new Map();
  for (const r of rules) counts.set(r.source.name, { ...r.source, rules: (counts.get(r.source.name)?.rules ?? 0) + 1 });
  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Answers the request when it is one of the rules routes; returns false otherwise. */
export function handleRules(req, url, res) {
  if (req.method !== "GET" || (url.pathname !== "/rules" && url.pathname !== "/rules/sources")) return false;
  const out = url.pathname === "/rules" ? listRules(url.searchParams) : { status: 200, body: listSources() };
  const headers = { "content-type": "application/json" };
  if (out.total !== undefined) headers["x-total-count"] = String(out.total);
  res.writeHead(out.status, headers);
  res.end(JSON.stringify(out.body));
  return true;
}
