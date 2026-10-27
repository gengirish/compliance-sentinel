/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed JSON responses */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { auditRuns, findings, LOCAL_TENANT_ID, repos, rules, sources, tenants, type Trigger } from "../src/db/schema.js";
import { TENANT_HEADER } from "../src/db/tenants.js";
import { createApp } from "../src/web/server.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const OTHER = "org_other";
const PAGING = "org_paging";

type Label = "r1" | "r2" | "r3" | "r4" | "r5";
type F = { status: "compliant" | "violation" | "needs_review"; severity: "critical" | "high" | "medium" | "low" };

/**
 * `GET /runs` filters, sorts and pages (docs/plan-filter-sort.md F1). Five runs of the local
 * tenant with distinct values for every sort key, plus another tenant's runs that match every
 * filter and must never show, and a third tenant with 30 runs to page through.
 */
describe("GET /runs: filter, sort and page", () => {
  let handle: DbHandle;
  let app: ReturnType<typeof createApp>;
  const ids = {} as Record<Label, number>;
  const otherIds: number[] = [];
  let repoA1: number;
  let repoA2: number;
  let repoB: number;

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    const db = handle.db;
    const [source] = await db.insert(sources).values({ name: "test-source", kind: "fixture", url: "https://example.com" }).returning();
    const [rule] = await db
      .insert(rules)
      .values({ sourceId: source!.id, externalId: "T-1", title: "Test rule", url: "https://example.com/t-1", contentHash: "h", rawText: "text" })
      .returning();
    const [other] = await db.insert(tenants).values({ name: "Other Co", clerkOrgId: OTHER }).returning();
    const [paging] = await db.insert(tenants).values({ name: "Paging Co", clerkOrgId: PAGING }).returning();
    const repo = async (tenantId: number, fullName: string) =>
      (await db.insert(repos).values({ tenantId, fullName }).returning())[0]!.id;
    repoA1 = await repo(LOCAL_TENANT_ID, "acme/one");
    repoA2 = await repo(LOCAL_TENANT_ID, "acme/two");
    repoB = await repo(other!.id, "other/one");

    const addRun = async (
      tenantId: number,
      run: { status: (typeof auditRuns.$inferInsert)["status"]; trigger: Trigger; started: string; seconds: number | null; cost: number; repoId: number | null },
      found: F[] = [],
    ) => {
      const startedAt = new Date(run.started);
      const [row] = await db
        .insert(auditRuns)
        .values({
          tenantId,
          repoId: run.repoId,
          status: run.status,
          trigger: run.trigger,
          startedAt,
          finishedAt: run.seconds === null ? null : new Date(startedAt.getTime() + run.seconds * 1000),
          costUsd: run.cost,
        })
        .returning();
      if (found.length) {
        await db.insert(findings).values(found.map((f) => ({ ...f, runId: row!.id, ruleId: rule!.id, obligation: "o", rationale: "r" })));
      }
      return row!.id;
    };
    const v = (severity: F["severity"]): F => ({ status: "violation", severity });

    ids.r1 = await addRun(
      LOCAL_TENANT_ID,
      { status: "completed", trigger: "cron", started: "2026-10-01T10:00:00Z", seconds: 60, cost: 0.5, repoId: repoA1 },
      [v("critical"), v("critical"), v("high"), { status: "compliant", severity: "low" }],
    );
    ids.r2 = await addRun(LOCAL_TENANT_ID, {
      status: "failed",
      trigger: "manual",
      started: "2026-10-02T23:30:00Z",
      seconds: 600,
      cost: 0.1,
      repoId: repoA2,
    });
    ids.r3 = await addRun(
      LOCAL_TENANT_ID,
      { status: "completed", trigger: "pull_request", started: "2026-10-03T00:00:00Z", seconds: 30, cost: 2, repoId: repoA1 },
      [v("high"), { status: "needs_review", severity: "critical" }],
    );
    ids.r4 = await addRun(LOCAL_TENANT_ID, { status: "skipped", trigger: "cron", started: "2026-10-04T12:00:00Z", seconds: 1, cost: 0, repoId: null });
    ids.r5 = await addRun(
      LOCAL_TENANT_ID,
      { status: "running", trigger: "push", started: "2026-10-05T08:00:00Z", seconds: null, cost: 0.3, repoId: repoA2 },
      [v("critical")],
    );

    // Another tenant's runs, one matching each filter value, all with critical violations.
    const statuses = ["running", "completed", "skipped", "failed"] as const;
    const triggers = ["cron", "manual", "install", "pull_request", "push"] as const;
    for (let i = 0; i < 5; i++) {
      otherIds.push(
        await addRun(
          other!.id,
          {
            status: statuses[i % 4]!,
            trigger: triggers[i]!,
            started: `2026-10-0${i + 1}T12:00:00Z`,
            seconds: i === 0 ? null : 10 * i,
            cost: 9,
            repoId: repoB,
          },
          [v("critical"), v("critical"), v("critical"), v("critical")],
        ),
      );
    }
    for (let i = 0; i < 30; i++) {
      await addRun(paging!.id, { status: "completed", trigger: "cron", started: "2026-09-01T00:00:00Z", seconds: 5, cost: 0, repoId: null });
    }

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
  /** The labels of the local tenant's runs, in response order; fails on any other tenant's run. */
  const labels = async (query: string): Promise<Label[]> => {
    const { status, body, total } = await get(`/runs${query}`);
    expect(status).toBe(200);
    expect(Number(total)).toBe(body.length);
    const byId = new Map(Object.entries(ids).map(([k, id]) => [id, k as Label]));
    return body.map((r: any) => {
      expect(byId.has(r.id), `run ${r.id} is not the local tenant's`).toBe(true);
      return byId.get(r.id)!;
    });
  };

  it("lists the newest runs first with no parameters, without counts", async () => {
    const { body, total } = await get("/runs");
    expect(body.map((r: any) => r.id)).toEqual([ids.r5, ids.r4, ids.r3, ids.r2, ids.r1]);
    expect(total).toBe("5");
    expect(body[0].counts).toBeUndefined();
  });

  it("keeps the counts shape with counts=1", async () => {
    const { body } = await get("/runs?counts=1");
    const r1 = body.find((r: any) => r.id === ids.r1);
    expect(r1.counts).toEqual({
      total: 4,
      byStatus: { compliant: 1, violation: 3, needs_review: 0 },
      bySeverity: { critical: 2, high: 1, medium: 0, low: 1 },
      criticalViolations: 2,
    });
    const r2 = body.find((r: any) => r.id === ids.r2);
    expect(r2.counts).toEqual({
      total: 0,
      byStatus: { compliant: 0, violation: 0, needs_review: 0 },
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      criticalViolations: 0,
    });
  });

  describe("filters", () => {
    it.each([
      ["?status=completed", ["r3", "r1"]],
      ["?status=failed,skipped", ["r4", "r2"]],
      ["?status=running", ["r5"]],
      ["?trigger=cron", ["r4", "r1"]],
      ["?trigger=manual,push", ["r5", "r2"]],
      ["?trigger=install", []],
      ["?from=2026-10-03", ["r5", "r4", "r3"]],
      // `to` is inclusive: a run late on the 2nd (UTC) is in, one at midnight on the 3rd is not.
      ["?to=2026-10-02", ["r2", "r1"]],
      ["?from=2026-10-02&to=2026-10-02", ["r2"]],
      ["?from=2026-10-03&to=2026-10-04", ["r4", "r3"]],
      // A critical finding that needs review is not a critical violation (r3).
      ["?critical=1", ["r5", "r1"]],
      ["?critical=0", ["r5", "r4", "r3", "r2", "r1"]],
      ["?repo=REPO_A1", ["r3", "r1"]],
      ["?repo=REPO_A2", ["r5", "r2"]],
      ["?status=completed&trigger=cron", ["r1"]],
      ["?status=completed,running&critical=1&from=2026-10-02", ["r5"]],
      ["?trigger=cron,pull_request&repo=REPO_A1&to=2026-10-02", ["r1"]],
      ["?status=failed&critical=1", []],
    ] as const)("%s", async (query, expected) => {
      const q = query.replace("REPO_A1", String(repoA1)).replace("REPO_A2", String(repoA2));
      expect(await labels(q)).toEqual(expected);
    });
  });

  describe("sorts", () => {
    it.each([
      ["started", "desc", ["r5", "r4", "r3", "r2", "r1"]],
      ["started", "asc", ["r1", "r2", "r3", "r4", "r5"]],
      // The running run has no duration yet and sorts last either way.
      ["duration", "desc", ["r2", "r1", "r3", "r4", "r5"]],
      ["duration", "asc", ["r4", "r3", "r1", "r2", "r5"]],
      ["cost", "desc", ["r3", "r1", "r5", "r2", "r4"]],
      ["cost", "asc", ["r4", "r2", "r5", "r1", "r3"]],
      // Ties fall back to the run id in the same direction; runs without findings count as zero.
      ["violations", "desc", ["r1", "r5", "r3", "r4", "r2"]],
      ["violations", "asc", ["r2", "r4", "r3", "r5", "r1"]],
      ["critical", "desc", ["r1", "r5", "r4", "r3", "r2"]],
      ["critical", "asc", ["r2", "r3", "r4", "r5", "r1"]],
    ] as const)("%s %s", async (sort, order, expected) => {
      expect(await labels(`?sort=${sort}&order=${order}`)).toEqual(expected);
    });

    it("defaults the order to desc", async () => {
      expect(await labels("?sort=cost")).toEqual(["r3", "r1", "r5", "r2", "r4"]);
    });

    it("sorts within a filter", async () => {
      expect(await labels("?status=completed,running&sort=violations&order=asc")).toEqual(["r3", "r5", "r1"]);
    });
  });

  describe("paging", () => {
    it("pages 25 at a time and reports the unpaged total", async () => {
      const one = await get("/runs", PAGING);
      const two = await get("/runs?page=2", PAGING);
      const three = await get("/runs?page=3", PAGING);
      expect([one.body.length, two.body.length, three.body.length]).toEqual([25, 5, 0]);
      expect([one.total, two.total, three.total]).toEqual(["30", "30", "30"]);
      // Equal start times: the id tie-breaker keeps pages disjoint and in order.
      const all = [...one.body, ...two.body].map((r: any) => r.id);
      expect(new Set(all).size).toBe(30);
      expect(all).toEqual([...all].sort((a, b) => b - a));
    });

    it("takes a larger limit", async () => {
      const { body, total } = await get("/runs?limit=50", PAGING);
      expect(body.length).toBe(30);
      expect(total).toBe("30");
    });

    it("counts the filtered rows, not the page", async () => {
      const { body, total } = await get("/runs?status=completed&limit=25&page=1");
      expect(body.length).toBe(2);
      expect(total).toBe("2");
    });
  });

  it.each([
    ["status=bogus", "status"],
    ["status=completed,bogus", "status"],
    ["trigger=scheduled", "trigger"],
    ["from=2026-13-01", "from"],
    ["from=10/01/2026", "from"],
    ["to=yesterday", "to"],
    ["from=2026-10-05&to=2026-10-01", "to"],
    ["critical=yes", "critical"],
    ["repo=abc", "repo"],
    ["repo=0", "repo"],
    ["sort=name", "sort"],
    ["order=up", "order"],
    ["page=0", "page"],
    ["page=1.5", "page"],
    ["limit=10", "limit"],
    ["counts=yes", "counts"],
  ])("rejects %s with a 400 naming %s", async (query, field) => {
    const { status, body } = await get(`/runs?${query}`);
    expect(status).toBe(400);
    expect(body.issues.some((i: any) => i.path.startsWith(field))).toBe(true);
  });

  describe("tenant isolation", () => {
    const everyFilter = [
      "",
      "?counts=1",
      "?status=running,completed,skipped,failed",
      "?trigger=cron,manual,install,pull_request,push",
      "?from=2026-10-01&to=2026-10-05",
      "?critical=1",
      "?sort=duration",
      "?sort=cost&order=asc",
      "?sort=violations",
      "?sort=critical",
      "?limit=100",
    ];

    it("never shows another tenant's runs, under any filter or sort", async () => {
      for (const query of everyFilter) {
        const { body } = await get(`/runs${query}`);
        expect(body.some((r: any) => otherIds.includes(r.id)), query).toBe(false);
      }
      // Asking for the other tenant's repo by id finds nothing, rather than its runs.
      const { body, total } = await get(`/runs?repo=${repoB}`);
      expect(body).toEqual([]);
      expect(total).toBe("0");
    });

    it("shows the other tenant only its own runs, with its own counts", async () => {
      for (const query of everyFilter) {
        const { body } = await get(`/runs${query}`, OTHER);
        expect(body.every((r: any) => otherIds.includes(r.id)), query).toBe(true);
      }
      expect((await get(`/runs?repo=${repoA1}`, OTHER)).body).toEqual([]);
      const { body } = await get("/runs?critical=1&counts=1", OTHER);
      expect(body.length).toBe(5);
      expect(body.every((r: any) => r.counts.criticalViolations === 4)).toBe(true);
    });

    it("shows an unknown tenant nothing, with a zero total", async () => {
      for (const query of everyFilter) {
        const { status, body, total } = await get(`/runs${query}`, "org_nobody");
        expect(status).toBe(200);
        expect(body).toEqual([]);
        expect(total).toBe("0");
      }
    });
  });
});
