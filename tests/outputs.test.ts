import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { auditRuns } from "../src/db/schema.js";
import { aggregateFindings } from "../src/graph/nodes/aggregate.js";
import { severityGate } from "../src/graph/nodes/notify.js";
import type { AuditStateType, NotifyInput } from "../src/graph/state.js";
import { summarize, type Finding } from "../src/graph/types.js";
import { OfflineAnalyst } from "../src/llm/offlineAnalyst.js";
import { buildEmail } from "../src/notify/email.js";
import { buildSlackMessage } from "../src/notify/slack.js";
import { runPipeline } from "../src/pipeline/run.js";
import type { AuditJobData } from "../src/queue/queue.js";
import { processAuditJob } from "../src/queue/worker.js";
import { LocalHashEmbedder } from "../src/rag/embed.js";
import { buildReportData, renderHtml } from "../src/report/render.js";
import { createApp } from "../src/web/server.js";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  ruleId: 1,
  obligationId: "1-0",
  obligation: "Personal data must not be logged.",
  status: "violation",
  severity: "critical",
  rationale: "A log statement writes an SSN.",
  evidence: [{ path: "src/a.js", start_line: 3, end_line: 3, excerpt: "console.log(ssn)" }],
  citationChunkIds: [1],
  verification: [],
  ...overrides,
});

describe("aggregateFindings", () => {
  it("merges the same rule, verdict and code location reached twice", () => {
    const merged = aggregateFindings([
      finding(),
      finding({ obligationId: "1-1", obligation: "Logs must exclude identifiers.", severity: "high", citationChunkIds: [2] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.severity).toBe("critical");
    expect(merged[0]?.citationChunkIds).toEqual([1, 2]);
    expect(merged[0]?.obligation).toContain("Logs must exclude identifiers.");
    expect(merged[0]?.evidence).toHaveLength(1);
  });

  it("keeps distinct duties broken in the same file apart", () => {
    const merged = aggregateFindings([
      finding(),
      finding({ obligationId: "1-1", obligation: "Consent must be captured.", evidence: [{ path: "src/a.js", start_line: 20, end_line: 21, excerpt: "x" }] }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("keeps the same location apart across rules and orders worst-first", () => {
    const merged = aggregateFindings([
      finding({ status: "compliant", severity: "low", obligationId: "1-2", evidence: [{ path: "src/b.js", start_line: 1, end_line: 1, excerpt: "y" }] }),
      finding({ ruleId: 2, obligationId: "2-0", severity: "high" }),
      finding({ status: "needs_review", severity: "medium", obligationId: "1-3", evidence: [] }),
      finding(),
    ]);
    expect(merged.map((f) => [f.status, f.severity])).toEqual([
      ["violation", "critical"],
      ["violation", "high"],
      ["needs_review", "medium"],
      ["compliant", "low"],
    ]);
  });
});

describe("severity gate", () => {
  const state = (findings: Finding[]) => ({ summary: summarize(findings) }) as AuditStateType;

  it("routes to notify only when a critical violation exists", () => {
    expect(severityGate(state([finding()]))).toBe("notify");
    expect(severityGate(state([finding({ severity: "high" })]))).toBe("__end__");
    // A critical-severity item that is not a violation does not page anyone.
    expect(severityGate(state([finding({ status: "needs_review" })]))).toBe("__end__");
    expect(severityGate({ summary: null } as AuditStateType)).toBe("__end__");
  });
});

describe("alert payloads", () => {
  const findings = [finding(), finding({ severity: "high", obligationId: "1-1", obligation: "High one." })];
  const input: NotifyInput = { runId: 42, summary: summarize(findings), findings, reportUrl: "https://files.test/run-42.pdf?sig=abc" };

  it("builds a Slack message with the critical findings and a report button", () => {
    const message = buildSlackMessage(input);
    expect(message.text).toBe("1 critical compliance violation found (audit run 42)");
    const json = JSON.stringify(message.blocks);
    expect(json).toContain("Personal data must not be logged.");
    expect(json).toContain("src/a.js:3");
    expect(json).not.toContain("High one.");
    expect(json).toContain("https://files.test/run-42.pdf?sig=abc");
  });

  it("shows a local report path as text rather than a broken link button", () => {
    const json = JSON.stringify(buildSlackMessage({ ...input, reportUrl: "C:\\reports\\run-42.pdf" }).blocks);
    expect(json).not.toContain('"type":"button"');
    expect(json).toContain("run-42.pdf");
  });

  it("escapes HTML in the email body", () => {
    const email = buildEmail({ ...input, findings: [finding({ obligation: "Never log <script>alert(1)</script>." })] });
    expect(email.subject).toContain("1 critical violation in audit run 42");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).not.toContain("<script>");
  });
});

describe("report, web and worker against a real run", () => {
  let handle: DbHandle;
  let runId: number;
  let html: string;

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    const analyst = new OfflineAnalyst();
    const result = await runPipeline({
      trigger: "manual",
      demo: true,
      handle,
      analyst,
      embedder: new LocalHashEmbedder(),
      deps: {
        renderReport: async (state) => {
          html = renderHtml(await buildReportData(handle.db, { ...state, analyst: analyst.name }));
          return { url: "memory://report", path: "memory://report" };
        },
        notify: async () => [],
      },
    });
    runId = result.runId;
  });
  afterAll(() => handle.close());

  it("renders findings with regulation citations, code locations and the disclaimer", () => {
    expect(html).toContain("Regulatory audit of demo-target-app");
    expect(html).toContain("Critical violations");
    expect(html).toContain("src/routes/signup.js:10");
    expect(html).toContain("Article 33");
    expect(html).toContain("https://eur-lex.europa.eu/eli/reg/2016/679/oj");
    expect(html).toContain("Effective 2018-05-25");
    expect(html).toContain("It is not legal advice");
    expect(html).toContain("Appendix A: Rules in scope");
    // Code excerpts are escaped, not injected as markup.
    expect(html).toContain("console.log(&quot;New signup&quot;");
  });

  const app = (queue?: Partial<Queue<AuditJobData>>) =>
    createApp({ db: handle.db, getQueue: () => queue as Queue<AuditJobData>, token: "s3cret-token" });

  it("serves /health without a token", async () => {
    const res = await app().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects a manual trigger without the right token", async () => {
    expect((await app().request("/runs", { method: "POST" })).status).toBe(401);
    const wrong = await app().request("/runs", { method: "POST", headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("keeps protected routes closed when no token is configured", async () => {
    const closed = createApp({ db: handle.db, getQueue: () => ({}) as Queue<AuditJobData> });
    expect((await closed.request("/runs", { method: "POST" })).status).toBe(503);
  });

  it("enqueues a manual audit and passes the demo flag through", async () => {
    const added: unknown[] = [];
    const queue = { add: async (name: string, data: AuditJobData) => (added.push([name, data]), { id: "job-7" }) };
    const res = await app(queue as unknown as Partial<Queue<AuditJobData>>).request("/runs?demo=1", {
      method: "POST",
      headers: { authorization: "Bearer s3cret-token" },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ jobId: "job-7", demo: true });
    expect(added).toEqual([["manual-audit", { demo: true, trigger: "manual" }]]);
  });

  it("returns 404 for a run whose report file is gone and 400 for a bad id", async () => {
    const headers = { authorization: "Bearer s3cret-token" };
    expect((await app().request(`/reports/${runId}`, { headers })).status).toBe(404);
    expect((await app().request("/reports/abc", { headers })).status).toBe(400);
    expect((await app().request("/reports/99999", { headers })).status).toBe(404);
  });

  it("lists recent runs", async () => {
    const res = await app().request("/runs", { headers: { authorization: "Bearer s3cret-token" } });
    const rows = (await res.json()) as { id: number; status: string }[];
    expect(rows[0]).toMatchObject({ id: runId, status: "completed" });
    expect(await handle.db.select().from(auditRuns)).toHaveLength(rows.length);
  });

  it("worker job handler forwards job data to the pipeline and returns a summary", async () => {
    const calls: unknown[] = [];
    const summary = await processAuditJob({ trigger: "cron", demo: true }, async (opts) => {
      calls.push(opts);
      return { runId: 9, status: "skipped", analyst: "", rulesInScope: [], digests: [], summary: null, reportUrl: null, reportPath: null, costUsd: 0, errors: [], notified: [] };
    });
    expect(calls).toEqual([{ trigger: "cron", demo: true, ruleIds: undefined }]);
    expect(summary).toEqual({ runId: 9, status: "skipped", summary: null, reportUrl: null, costUsd: 0, notified: [] });
  });
});
