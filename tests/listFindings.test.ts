/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed JSON responses */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { auditRuns, findings, LOCAL_TENANT_ID, rules, sources, tenants, type CodeEvidence } from "../src/db/schema.js";
import { TENANT_HEADER } from "../src/db/tenants.js";
import { createApp } from "../src/web/server.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

const at = (path: string): CodeEvidence => ({ path, start_line: 1, end_line: 2, excerpt: "x" });

/** Filters and sort of `GET /runs/:id/findings` (docs/plan-filter-sort.md §3 F2), on hand-made findings. */
describe("GET /runs/:id/findings filters and sort", () => {
  let handle: DbHandle;
  let app: ReturnType<typeof createApp>;
  let runId: number;
  let otherRunId: number;
  let alpha: number;
  let beta: number;
  /** Finding ids by their obligation, so assertions read as names. */
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    const { db } = handle;
    const [source] = await db.insert(sources).values({ name: "test-source", kind: "fixture", url: "https://example.com" }).returning();
    const rule = (externalId: string, title: string) => ({
      sourceId: source!.id,
      externalId,
      title,
      url: `https://example.com/${externalId}`,
      contentHash: externalId,
      rawText: title,
    });
    const inserted = await db.insert(rules).values([rule("A-1", "Alpha rule"), rule("B-1", "Beta rule")]).returning();
    alpha = inserted[0]!.id;
    beta = inserted[1]!.id;

    const [run] = await db.insert(auditRuns).values({ tenantId: LOCAL_TENANT_ID, status: "completed", trigger: "manual" }).returning();
    runId = run!.id;
    const [other] = await db.insert(tenants).values({ name: "Other Co", clerkOrgId: "org_other" }).returning();
    const [otherRun] = await db.insert(auditRuns).values({ tenantId: other!.id, status: "completed", trigger: "manual" }).returning();
    otherRunId = otherRun!.id;

    // Inserted out of order, so the default sort has something to do.
    const rows = [
      { name: "low-compliant", ruleId: beta, status: "compliant", severity: "low", evidence: [] },
      { name: "high-review", ruleId: alpha, status: "needs_review", severity: "high", evidence: [at("src/payments/refund.ts")] },
      { name: "critical-compliant", ruleId: beta, status: "compliant", severity: "critical", evidence: [at("lib/util.ts")] },
      { name: "critical-violation", ruleId: alpha, status: "violation", severity: "critical", evidence: [at("src/payments/charge.ts")] },
      { name: "high-violation", ruleId: beta, status: "violation", severity: "high", evidence: [at("docs/readme.md"), at("src/payments/card.ts")] },
      { name: "medium-literal", ruleId: alpha, status: "violation", severity: "medium", evidence: [at("src/100%_done/a.ts")] },
      { name: "medium-lookalike", ruleId: alpha, status: "violation", severity: "medium", evidence: [at("src/100x-done/a.ts")] },
    ] as const;
    for (const r of rows) {
      const [f] = await db
        .insert(findings)
        .values({
          runId,
          ruleId: r.ruleId,
          obligation: `Obligation ${r.name}`,
          status: r.status,
          severity: r.severity,
          evidence: [...r.evidence],
          rationale: r.name === "high-review" ? "Tokenise card numbers before storage." : `Because of ${r.name}.`,
        })
        .returning({ id: findings.id });
      ids[r.name] = f!.id;
    }
    // Another tenant's finding that matches every filter used below.
    await db.insert(findings).values({
      runId: otherRunId,
      ruleId: alpha,
      obligation: "Obligation critical-violation",
      status: "violation",
      severity: "critical",
      evidence: [at("src/payments/charge.ts")],
      rationale: "Tokenise card numbers before storage.",
    });

    app = createApp({
      db,
      getQueue: () => {
        throw new Error("queue not available in tests");
      },
      token: TOKEN,
    });
  });
  afterAll(() => handle.close());

  const get = async (query: string, opts: { run?: number; tenant?: string } = {}) => {
    const headers = opts.tenant ? { ...auth, [TENANT_HEADER]: opts.tenant } : auth;
    const res = await app.request(`/runs/${opts.run ?? runId}/findings${query}`, { headers });
    return { status: res.status, body: (await res.json()) as any };
  };
  /** The names of the findings returned, in order. */
  const names = async (query: string) => {
    const { status, body } = await get(query);
    expect(status, query).toBe(200);
    const byId = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
    return (body as any[]).map((f) => byId.get(f.id));
  };

  describe("filters", () => {
    it("by rule", async () => {
      expect((await names(`?rule=${beta}`)).sort()).toEqual(["critical-compliant", "high-violation", "low-compliant"]);
      expect(await names("?rule=999999")).toEqual([]);
    });

    it("by evidence path prefix, matching any evidence location", async () => {
      expect((await names("?path=src/payments")).sort()).toEqual(["critical-violation", "high-review", "high-violation"]);
      expect(await names("?path=lib/")).toEqual(["critical-compliant"]);
      // A prefix, not a substring.
      expect(await names("?path=payments")).toEqual([]);
    });

    it("takes % and _ in the path literally", async () => {
      expect(await names(`?path=${encodeURIComponent("src/100%_done")}`)).toEqual(["medium-literal"]);
      expect(await names(`?path=${encodeURIComponent("src/100%")}`)).toEqual(["medium-literal"]);
      expect(await names(`?path=${encodeURIComponent("src/100_")}`)).toEqual([]);
      expect(await names(`?path=${encodeURIComponent("%")}`)).toEqual([]);
    });

    it("searches the obligation and the rationale, case-insensitively", async () => {
      expect(await names("?q=TOKENISE")).toEqual(["high-review"]);
      expect(await names("?q=obligation%20critical-v")).toEqual(["critical-violation"]);
      expect(await names(`?q=${encodeURIComponent("%")}`)).toEqual([]);
      // Blank search is no search.
      expect(await names("?q=%20%20")).toHaveLength(7);
    });

    it("keeps the status and severity filters", async () => {
      expect(await names("?status=violation&severity=critical")).toEqual(["critical-violation"]);
      expect(await names("?status=compliant")).toEqual(["critical-compliant", "low-compliant"]);
    });

    it("combines every filter", async () => {
      expect(await names(`?status=violation,needs_review&severity=critical,high&rule=${alpha}&path=src/payments&q=obligation`)).toEqual([
        "critical-violation",
        "high-review",
      ]);
      expect(await names(`?status=violation&rule=${alpha}&path=src/payments&q=tokenise`)).toEqual([]);
      expect(await names(`?severity=high&rule=${beta}&path=src/payments/card`)).toEqual(["high-violation"]);
    });
  });

  describe("sort", () => {
    const worstFirst = [
      "critical-violation",
      "critical-compliant",
      "high-violation",
      "high-review",
      "medium-literal",
      "medium-lookalike",
      "low-compliant",
    ];

    it("defaults to critical first, then violation before needs review before compliant", async () => {
      expect(await names("")).toEqual(worstFirst);
      expect(await names("?sort=severity&order=desc")).toEqual(worstFirst);
    });

    it("by severity ascending is the reverse, with id still breaking ties", async () => {
      expect(await names("?sort=severity&order=asc")).toEqual([
        "low-compliant",
        "medium-literal",
        "medium-lookalike",
        "high-review",
        "high-violation",
        "critical-compliant",
        "critical-violation",
      ]);
    });

    it("by status in both directions, severity next", async () => {
      expect(await names("?sort=status&order=desc")).toEqual([
        "critical-violation",
        "high-violation",
        "medium-literal",
        "medium-lookalike",
        "high-review",
        "critical-compliant",
        "low-compliant",
      ]);
      expect(await names("?sort=status&order=asc")).toEqual([
        "low-compliant",
        "critical-compliant",
        "high-review",
        "medium-literal",
        "medium-lookalike",
        "high-violation",
        "critical-violation",
      ]);
    });

    it("by rule title in both directions, worst first within a rule", async () => {
      const alphaRule = ["critical-violation", "high-review", "medium-literal", "medium-lookalike"];
      const betaRule = ["critical-compliant", "high-violation", "low-compliant"];
      expect(await names("?sort=rule&order=asc")).toEqual([...alphaRule, ...betaRule]);
      expect(await names("?sort=rule&order=desc")).toEqual([...betaRule, ...alphaRule]);
    });

    it("by first evidence path in both directions, findings without evidence last", async () => {
      const byPath = [
        "high-violation", // docs/readme.md
        "critical-compliant", // lib/util.ts
        "medium-literal", // src/100%_done
        "medium-lookalike", // src/100x-done
        "critical-violation", // src/payments/charge.ts
        "high-review", // src/payments/refund.ts
      ];
      expect(await names("?sort=path&order=asc")).toEqual([...byPath, "low-compliant"]);
      expect(await names("?sort=path&order=desc")).toEqual([...byPath.reverse(), "low-compliant"]);
    });

    it("sorts a filtered list by the first evidence path, not the one that matched", async () => {
      expect(await names("?path=src/payments&sort=path&order=asc")).toEqual(["high-violation", "critical-violation", "high-review"]);
    });
  });

  it("answers 400 naming the bad field", async () => {
    for (const [query, field] of [
      ["?rule=abc", "rule"],
      ["?rule=0", "rule"],
      ["?rule=1.5", "rule"],
      ["?sort=title", "sort"],
      ["?order=up", "order"],
      [`?q=${"x".repeat(101)}`, "q"],
      [`?path=${"x".repeat(201)}`, "path"],
      ["?status=open", "status"],
    ] as const) {
      const { status, body } = await get(query);
      expect(status, query).toBe(400);
      expect(body.issues.some((i: any) => i.path.startsWith(field)), query).toBe(true);
    }
  });

  it("answers 404 for another tenant's run under any filter", async () => {
    const queries = ["", `?rule=${alpha}`, "?path=src/payments", "?q=tokenise", "?sort=path&order=asc", "?status=violation&severity=critical"];
    for (const query of queries) {
      expect((await get(query, { run: otherRunId })).status, query).toBe(404);
      expect((await get(query, { tenant: "org_other" })).status, query).toBe(404);
      expect((await get(query, { tenant: "org_nobody" })).status, query).toBe(404);
    }
    // The owner still sees their own run, and only its findings.
    const theirs = await get("?path=src/payments", { run: otherRunId, tenant: "org_other" });
    expect(theirs.body).toHaveLength(1);
    expect(theirs.body[0].runId).toBe(otherRunId);
  });
});
