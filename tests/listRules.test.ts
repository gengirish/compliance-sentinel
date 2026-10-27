/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed JSON responses */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { auditRuns, findings, LOCAL_TENANT_ID, rules, sources, tenants } from "../src/db/schema.js";
import { TENANT_HEADER } from "../src/db/tenants.js";
import { createApp } from "../src/web/server.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/**
 * `GET /rules` filters, sorts and pages (docs/plan-filter-sort.md F3), over a small hand-made
 * set of rules so every expected order can be written out.
 */
describe("GET /rules list query", () => {
  let handle: DbHandle;
  let app: ReturnType<typeof createApp>;
  /** Rule ids by external id. */
  const ids: Record<string, number> = {};
  let localRunId: number;
  let otherRunId: number;

  // externalId, title, source, effective date, first seen (days ago), last changed (days ago)
  const fixtures: [string, string, string, string | null, number, number][] = [
    ["ESMA-1", "MiCA guidelines", "esma", "2025-06-30", 200, 3],
    ["ESMA-2", "Market abuse Q&A", "esma", "2024-01-15", 150, 45],
    ["FR-2024-01", "Safeguards amendment", "federal-register", "2024-05-13", 120, 10],
    ["FR-2023-99", "Privacy of consumer data", "federal-register", null, 100, 120],
    ["EURLEX-1", "Digital operational resilience", "eur-lex", "17 January 2025", 90, 60],
    ["PCI-4", "100% literal_rule", "pci-ssc-demo", "2025-03-31", 80, 1],
  ];

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    const db = handle.db;
    const sourceIds: Record<string, number> = {};
    for (const name of ["esma", "federal-register", "eur-lex", "pci-ssc-demo"]) {
      const [s] = await db
        .insert(sources)
        .values({ name, kind: name.endsWith("-demo") ? "fixture" : "api", url: `https://example.com/${name}` })
        .returning({ id: sources.id });
      sourceIds[name] = s!.id;
    }
    for (const [externalId, title, source, effectiveDate, firstSeen, lastChanged] of fixtures) {
      const [r] = await db
        .insert(rules)
        .values({
          sourceId: sourceIds[source]!,
          externalId,
          title,
          effectiveDate,
          url: `https://example.com/${externalId}`,
          contentHash: externalId,
          rawText: title,
          firstSeenAt: daysAgo(firstSeen),
          lastChangedAt: daysAgo(lastChanged),
        })
        .returning({ id: rules.id });
      ids[externalId] = r!.id;
    }

    // The local tenant audited ESMA-1 and FR-2024-01; the other tenant audited ESMA-2 and PCI-4.
    const [other] = await db.insert(tenants).values({ name: "Other Co", clerkOrgId: "org_other" }).returning({ id: tenants.id });
    const run = async (tenantId: number, audited: string[]) => {
      const [r] = await db
        .insert(auditRuns)
        .values({ tenantId, status: "completed", trigger: "manual" })
        .returning({ id: auditRuns.id });
      await db.insert(findings).values(
        audited.map((ext) => ({
          runId: r!.id,
          ruleId: ids[ext]!,
          obligation: `Obligation of ${ext}`,
          status: "violation" as const,
          severity: "high" as const,
          rationale: "test",
        })),
      );
      return r!.id;
    };
    localRunId = await run(LOCAL_TENANT_ID, ["ESMA-1", "FR-2024-01"]);
    otherRunId = await run(other!.id, ["ESMA-2", "PCI-4"]);

    app = createApp({
      db,
      getQueue: () => {
        throw new Error("queue not available in tests");
      },
      token: TOKEN,
    });
  });
  afterAll(() => handle.close());

  const get = async (path: string, tenant?: string) => {
    const res = await app.request(path, { headers: tenant ? { ...auth, [TENANT_HEADER]: tenant } : auth });
    return { status: res.status, total: res.headers.get("x-total-count"), body: (await res.json()) as any };
  };
  /** External ids of the rows, in order. */
  const list = async (path: string, tenant?: string): Promise<string[]> => {
    const res = await get(path, tenant);
    expect(res.status, path).toBe(200);
    return res.body.map((r: any) => r.externalId);
  };

  it("defaults to every rule, last changed first, with the total in a header", async () => {
    const res = await get("/rules");
    expect(res.total).toBe("6");
    expect(res.body.map((r: any) => r.externalId)).toEqual(["PCI-4", "ESMA-1", "FR-2024-01", "ESMA-2", "EURLEX-1", "FR-2023-99"]);
    // The row shape the dashboard's Rule schema parses.
    expect(Object.keys(res.body[0]).sort()).toEqual(
      ["effectiveDate", "externalId", "firstSeenAt", "id", "lastAuditedRunId", "lastChangedAt", "source", "title", "url"].sort(),
    );
    expect(res.body[0].source).toEqual({ name: "pci-ssc-demo", kind: "fixture" });
  });

  describe("filters", () => {
    it("searches title and external id, case-insensitively", async () => {
      expect(await list("/rules?q=esma")).toEqual(["ESMA-1", "ESMA-2"]);
      expect(await list("/rules?q=SAFEGUARDS")).toEqual(["FR-2024-01"]);
      expect(await list("/rules?q=fr-20")).toEqual(["FR-2024-01", "FR-2023-99"]);
      expect(await list("/rules?q=%20%20")).toHaveLength(6); // whitespace only is no search
    });

    it("takes % and _ in a search literally", async () => {
      expect(await list("/rules?q=100%25")).toEqual(["PCI-4"]);
      expect(await list("/rules?q=%25")).toEqual(["PCI-4"]);
      expect(await list("/rules?q=literal_rule")).toEqual(["PCI-4"]);
      // `_` would match any one character as a wildcard ("MiCA" has none in that position).
      expect(await list("/rules?q=Mi_A")).toEqual([]);
    });

    it("filters by one or more sources, including demo fixtures", async () => {
      expect(await list("/rules?source=esma")).toEqual(["ESMA-1", "ESMA-2"]);
      expect(await list("/rules?source=pci-ssc-demo,eur-lex")).toEqual(["PCI-4", "EURLEX-1"]);
      // A well-formed name with no rows matches nothing rather than failing.
      expect(await get("/rules?source=asic")).toMatchObject({ status: 200, total: "0", body: [] });
    });

    it("filters by whether this tenant audited the rule", async () => {
      expect(await list("/rules?audited=yes")).toEqual(["ESMA-1", "FR-2024-01"]);
      expect(await list("/rules?audited=no")).toEqual(["PCI-4", "ESMA-2", "EURLEX-1", "FR-2023-99"]);
    });

    it("filters by how recently the rule changed", async () => {
      expect(await list("/rules?changed=7")).toEqual(["PCI-4", "ESMA-1"]);
      expect(await list("/rules?changed=30")).toEqual(["PCI-4", "ESMA-1", "FR-2024-01"]);
      expect(await list("/rules?changed=90")).toEqual(["PCI-4", "ESMA-1", "FR-2024-01", "ESMA-2", "EURLEX-1"]);
    });

    it("filters by an inclusive effective-date range, skipping dates that are not ISO days", async () => {
      expect(await list("/rules?from=2025-01-01")).toEqual(["PCI-4", "ESMA-1"]);
      expect(await list("/rules?to=2024-05-13")).toEqual(["FR-2024-01", "ESMA-2"]);
      expect(await list("/rules?from=2024-05-13&to=2025-03-31")).toEqual(["PCI-4", "FR-2024-01"]);
      expect(await list("/rules?from=2025-03-31&to=2025-03-31")).toEqual(["PCI-4"]);
    });

    it("combines filters", async () => {
      // The plan's check: ESMA rules changed in the last 30 days that were never audited, oldest first.
      expect(await list("/rules?source=esma&changed=90&audited=no&sort=changed&order=asc")).toEqual(["ESMA-2"]);
      expect(await list("/rules?source=esma&changed=30&audited=no")).toEqual([]);
      expect(await list("/rules?q=a&source=esma,federal-register&audited=yes&from=2024-06-01")).toEqual(["ESMA-1"]);
      const res = await get("/rules?source=esma,federal-register&changed=90&limit=25");
      expect(res.total).toBe("3");
    });
  });

  describe("sorts", () => {
    const cases: [string, string[]][] = [
      ["changed", ["FR-2023-99", "EURLEX-1", "ESMA-2", "FR-2024-01", "ESMA-1", "PCI-4"]],
      ["first_seen", ["ESMA-1", "ESMA-2", "FR-2024-01", "FR-2023-99", "EURLEX-1", "PCI-4"]],
      ["title", ["PCI-4", "EURLEX-1", "ESMA-2", "ESMA-1", "FR-2023-99", "FR-2024-01"]],
    ];
    for (const [sort, ascending] of cases) {
      it(`sorts by ${sort} in both directions`, async () => {
        expect(await list(`/rules?sort=${sort}&order=asc`)).toEqual(ascending);
        expect(await list(`/rules?sort=${sort}&order=desc`)).toEqual([...ascending].reverse());
      });
    }

    it("sorts by source name, then id, in both directions", async () => {
      expect(await list("/rules?sort=source&order=asc")).toEqual(["ESMA-1", "ESMA-2", "EURLEX-1", "FR-2024-01", "FR-2023-99", "PCI-4"]);
      expect(await list("/rules?sort=source&order=desc")).toEqual(["PCI-4", "FR-2023-99", "FR-2024-01", "EURLEX-1", "ESMA-2", "ESMA-1"]);
    });

    it("sorts by effective date with undated rules last either way", async () => {
      // FR-2023-99 has no date and EURLEX-1 a non-ISO one; they keep id order (tie-breaker) at the end.
      expect(await list("/rules?sort=effective&order=asc")).toEqual(["ESMA-2", "FR-2024-01", "PCI-4", "ESMA-1", "FR-2023-99", "EURLEX-1"]);
      expect(await list("/rules?sort=effective&order=desc")).toEqual(["ESMA-1", "PCI-4", "FR-2024-01", "ESMA-2", "EURLEX-1", "FR-2023-99"]);
    });
  });

  describe("paging", () => {
    it("pages with a stable order and the unpaged total", async () => {
      // 6 rules fit one page of 25; the page after it is empty but still carries the total.
      const first = await get("/rules?limit=25");
      expect(first.total).toBe("6");
      expect(first.body).toHaveLength(6);
      const second = await get("/rules?limit=25&page=2");
      expect(second.total).toBe("6");
      expect(second.body).toEqual([]);
    });

    it("splits rows across pages when there are more than a page", async () => {
      // Enough rules for a second page of 25, under their own source so the other tests' lists are unchanged.
      const [s] = await handle.db
        .insert(sources)
        .values({ name: "bulk", kind: "api", url: "https://example.com/bulk" })
        .returning({ id: sources.id });
      await handle.db.insert(rules).values(
        Array.from({ length: 30 }, (_, i) => ({
          sourceId: s!.id,
          externalId: `BULK-${String(i).padStart(2, "0")}`,
          title: `Bulk rule ${i}`,
          url: `https://example.com/bulk/${i}`,
          contentHash: `bulk-${i}`,
          rawText: "bulk",
          lastChangedAt: daysAgo(500),
        })),
      );
      const p1 = await get("/rules?source=bulk&sort=title&order=asc&limit=25");
      const p2 = await get("/rules?source=bulk&sort=title&order=asc&limit=25&page=2");
      expect(p1.total).toBe("30");
      expect(p2.total).toBe("30");
      expect(p1.body).toHaveLength(25);
      expect(p2.body).toHaveLength(5);
      const all = [...p1.body, ...p2.body].map((r: any) => r.externalId);
      expect(new Set(all).size).toBe(30);
      // Default limit is 50: every bulk rule on one page.
      expect((await get("/rules?source=bulk")).body).toHaveLength(30);
      expect((await get("/rules")).total).toBe("36");
    });
  });

  it("answers 400 naming each bad parameter", async () => {
    const bad: [string, string][] = [
      ["/rules?sort=popularity", "sort"],
      ["/rules?order=up", "order"],
      ["/rules?page=0", "page"],
      ["/rules?page=x", "page"],
      ["/rules?limit=10", "limit"],
      ["/rules?audited=maybe", "audited"],
      ["/rules?changed=14", "changed"],
      ["/rules?from=2025-13-45", "from"],
      ["/rules?to=yesterday", "to"],
      ["/rules?from=2025-02-01&to=2025-01-01", "to"],
      ["/rules?source=ESMA", "source.0"],
      ["/rules?source=esma,a%20b", "source.1"],
      [`/rules?q=${"x".repeat(101)}`, "q"],
    ];
    for (const [path, field] of bad) {
      const res = await get(path);
      expect(res.status, path).toBe(400);
      expect(res.body.issues.map((i: any) => i.path), path).toContain(field);
    }
    const twoBad = await get("/rules?sort=x&audited=x");
    expect(twoBad.body.issues.map((i: any) => i.path).sort()).toEqual(["audited", "sort"]);
  });

  describe("tenant isolation", () => {
    it("reports the last audit of each rule from the caller's runs only", async () => {
      const mine = await get("/rules?audited=yes");
      expect(mine.body.map((r: any) => r.lastAuditedRunId)).toEqual([localRunId, localRunId]);
      const theirs = await get("/rules?audited=yes", "org_other");
      expect(theirs.body.map((r: any) => r.externalId)).toEqual(["PCI-4", "ESMA-2"]);
      expect(theirs.body.map((r: any) => r.lastAuditedRunId)).toEqual([otherRunId, otherRunId]);
    });

    it("does not count another tenant's runs as an audit", async () => {
      // PCI-4 and ESMA-2 were audited only by the other tenant: never audited for this one.
      const neverMine = await list("/rules?audited=no&source=esma,pci-ssc-demo");
      expect(neverMine).toEqual(["PCI-4", "ESMA-2"]);
      const neverTheirs = await list("/rules?audited=no&source=esma,pci-ssc-demo", "org_other");
      expect(neverTheirs).toEqual(["ESMA-1"]);
      const res = await get("/rules?audited=yes&q=esma", "org_other");
      expect(res.total).toBe("1");
      expect(res.body.every((r: any) => r.lastAuditedRunId !== localRunId)).toBe(true);
    });

    it("shows an unknown tenant every rule as never audited", async () => {
      expect((await get("/rules?audited=yes", "org_nobody")).total).toBe("0");
      const none = await get("/rules?audited=no&limit=100", "org_nobody");
      expect(none.total).toBe((await get("/rules")).total);
    });
  });

  it("lists the sources that have rules, with counts", async () => {
    const { status, body } = await get("/rules/sources");
    expect(status).toBe(200);
    expect(body.find((s: any) => s.name === "esma")).toEqual({ name: "esma", kind: "api", rules: 2 });
    expect(body.find((s: any) => s.name === "pci-ssc-demo")).toEqual({ name: "pci-ssc-demo", kind: "fixture", rules: 1 });
    expect(body.map((s: any) => s.name)).toEqual([...body.map((s: any) => s.name)].sort());
  });
});
