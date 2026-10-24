/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed JSON responses */
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { OfflineAnalyst } from "../src/llm/offlineAnalyst.js";
import { runPipeline } from "../src/pipeline/run.js";
import { LocalHashEmbedder } from "../src/rag/embed.js";
import { createApp } from "../src/web/server.js";

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

/** The dashboard's read endpoints, against a real demo audit in an in-memory database. */
describe("web API", () => {
  let handle: DbHandle;
  let app: Hono;
  let runId: number;

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    const result = await runPipeline({
      trigger: "manual",
      demo: true,
      handle,
      analyst: new OfflineAnalyst(),
      embedder: new LocalHashEmbedder(),
      deps: {
        renderReport: async (state) => ({ url: `memory://run-${state.runId}`, path: `memory://run-${state.runId}` }),
        notify: async () => ["test"],
      },
    });
    runId = result.state!.runId;
    app = createApp({
      db: handle.db,
      getQueue: () => {
        throw new Error("queue not available in tests");
      },
      token: TOKEN,
    });
  });
  afterAll(() => handle.close());

  const get = async (path: string) => {
    const res = await app.request(path, { headers: auth });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("rejects requests without the token", async () => {
    const res = await app.request("/stats");
    expect(res.status).toBe(401);
  });

  it("summarises the latest completed run", async () => {
    const { status, body } = await get("/stats");
    expect(status).toBe(200);
    expect(body.latestCompletedRun.id).toBe(runId);
    expect(body.latestCompletedRun.counts.byStatus.violation).toBeGreaterThanOrEqual(5);
    expect(body.totals.rules).toBeGreaterThan(0);
  });

  it("returns one run with counts, and 404 for an unknown run", async () => {
    const { body } = await get(`/runs/${runId}`);
    expect(body.counts.total).toBe(
      body.counts.byStatus.compliant + body.counts.byStatus.violation + body.counts.byStatus.needs_review,
    );
    expect((await get("/runs/9999")).status).toBe(404);
    expect((await get("/runs/abc")).status).toBe(400);
  });

  it("lists findings with rule and resolved citations, and filters them", async () => {
    const all = await get(`/runs/${runId}/findings`);
    expect(all.body.length).toBeGreaterThan(0);
    const violation = all.body.find((f: any) => f.status === "violation");
    expect(violation.rule.title).toBeTruthy();
    expect(violation.citations.length).toBeGreaterThan(0);
    expect(violation.evidence[0].path).toBeTruthy();

    const filtered = await get(`/runs/${runId}/findings?status=violation&severity=critical,bogus`);
    expect(filtered.body.length).toBeGreaterThan(0);
    expect(filtered.body.every((f: any) => f.status === "violation" && f.severity === "critical")).toBe(true);
  });

  it("lists rules with the last run that audited them", async () => {
    const { body } = await get("/rules");
    expect(body.length).toBeGreaterThan(0);
    expect(body.some((r: any) => r.lastAuditedRunId === runId)).toBe(true);
    expect(body[0].source.name).toBeTruthy();
  });
});
