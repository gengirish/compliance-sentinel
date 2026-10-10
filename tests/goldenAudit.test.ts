import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { auditRuns, findings as findingsTable } from "../src/db/schema.js";
import { COMPLIANT_AREAS, PLANTED_VIOLATIONS, scoreGolden } from "../src/eval/golden.js";
import type { NotifyInput } from "../src/graph/state.js";
import type { Analyst } from "../src/llm/analyst.js";
import { OfflineAnalyst } from "../src/llm/offlineAnalyst.js";
import { runPipeline, type PipelineResult } from "../src/pipeline/run.js";
import { LocalHashEmbedder } from "../src/rag/embed.js";

/**
 * Golden audit of demo-target-app. These tests run the real graph, database
 * and retrieval, with the offline keyword analyst standing in for Claude, so
 * they check the pipeline's plumbing and guards rather than model quality.
 * `pnpm eval:golden` runs the same scoring against Claude when a key is set.
 */
describe("golden audit of demo-target-app (offline analyst)", () => {
  let handle: DbHandle;
  let result: PipelineResult;
  const alerts: NotifyInput[] = [];

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    result = await runPipeline({
      trigger: "manual",
      demo: true,
      handle,
      analyst: new OfflineAnalyst(),
      embedder: new LocalHashEmbedder(),
      deps: {
        renderReport: async (state) => ({ url: `memory://run-${state.runId}`, path: `memory://run-${state.runId}` }),
        notify: async (input) => {
          alerts.push(input);
          return ["test"];
        },
      },
    });
  });
  afterAll(() => handle.close());

  it("finds all five planted violations", () => {
    const score = scoreGolden(result.state!.finalFindings);
    expect(score.missed).toEqual([]);
    expect(score.found).toHaveLength(PLANTED_VIOLATIONS.length);
    expect(score.recall).toBe(1);
  });

  it("does not flag the two compliant areas", () => {
    const final = result.state!.finalFindings;
    expect(scoreGolden(final).falselyFlagged).toEqual([]);
    for (const area of COMPLIANT_AREAS) {
      const compliant = final.filter(
        (f) => f.status === "compliant" && f.evidence.some((e) => area.files.includes(e.path)),
      );
      expect(compliant.length, `${area.id} should be reported compliant`).toBeGreaterThan(0);
    }
  });

  it("reports no violation outside the planted set", () => {
    expect(scoreGolden(result.state!.finalFindings).unexpected).toEqual([]);
  });

  it("gives every violation a regulation citation and a real file:line", () => {
    const violations = result.state!.finalFindings.filter((f) => f.status === "violation");
    expect(violations.length).toBeGreaterThanOrEqual(5);
    for (const finding of violations) {
      expect(finding.citationChunkIds.length).toBeGreaterThan(0);
      expect(finding.evidence.length).toBeGreaterThan(0);
      for (const item of finding.evidence) {
        expect(item.start_line).toBeGreaterThan(0);
        expect(item.excerpt.trim()).not.toBe("");
      }
    }
  });

  it("points the PII finding at the exact log statements", () => {
    const pii = result.state!.finalFindings.find((f) => f.status === "violation" && /logs/.test(f.obligation))!;
    const cited = pii.evidence.map((e) => `${e.path}:${e.start_line}`);
    expect(cited).toContain("src/routes/signup.js:10");
    expect(cited).toContain("src/routes/patients.js:12");
    expect(pii.evidence.find((e) => e.path === "src/routes/signup.js")?.excerpt).toContain("console.log");
  });

  it("alerts because critical findings exist, and records the run", async () => {
    expect(result.summary?.hasCritical).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(result.notified).toEqual(["test"]);

    const [run] = await handle.db.select().from(auditRuns);
    expect(run).toMatchObject({ status: "completed", trigger: "manual", reportUrl: `memory://run-${result.runId}` });
    expect(run?.rulesInScope).toEqual(result.rulesInScope);
    const stored = await handle.db.select().from(findingsTable);
    expect(stored).toHaveLength(result.state!.finalFindings.length);
  });
});

describe("pipeline guards", () => {
  it("skips the audit when no rule changed", async () => {
    const handle = await openMigratedDb({ pgliteDir: "memory" });
    try {
      const rule = { externalId: "R1", title: "Rule", effectiveDate: null, url: "https://example.test/r1", rawText: "Article 1\nConsent must be demonstrated by the controller for all processing." };
      const sources = [{ def: { name: "stub", kind: "api" as const, url: "https://example.test" }, fetch: async () => [rule] }];
      const common = {
        trigger: "cron" as const,
        handle,
        sources,
        analyst: new OfflineAnalyst(),
        embedder: new LocalHashEmbedder(),
        deps: { renderReport: async () => ({ url: "memory://r", path: "memory://r" }), notify: async () => [] },
      };

      const first = await runPipeline(common);
      expect(first.status).toBe("completed");
      expect(first.rulesInScope).toHaveLength(1);

      const second = await runPipeline(common);
      expect(second.status).toBe("skipped");
      expect(second.rulesInScope).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it("downgrades hallucinated citations to needs_review and sends no alert", async () => {
    const offline = new OfflineAnalyst();
    // Extracts honestly, then "assesses" by citing a chunk and a file that do not exist.
    const hallucinating: Analyst = {
      name: "hallucinating-stub",
      isRelevant: (rule, chunks) => offline.isRelevant(rule, chunks),
      extractObligations: (rule, chunks) => offline.extractObligations(rule, chunks),
      assess: async () => ({
        assessment: {
          status: "violation",
          severity: "critical",
          rationale: "Invented.",
          evidence: [{ path: "src/does-not-exist.js", start_line: 10, end_line: 12 }],
          citation_chunk_ids: [987_654],
        },
        costUsd: 0,
      }),
    };
    const handle = await openMigratedDb({ pgliteDir: "memory" });
    const alerts: NotifyInput[] = [];
    try {
      const result = await runPipeline({
        trigger: "manual",
        demo: true,
        handle,
        analyst: hallucinating,
        embedder: new LocalHashEmbedder(),
        deps: {
          renderReport: async () => ({ url: "memory://r", path: "memory://r" }),
          notify: async (input) => {
            alerts.push(input);
            return ["test"];
          },
        },
      });
      const final = result.state!.finalFindings;
      expect(final.length).toBeGreaterThan(0);
      expect(final.every((f) => f.status === "needs_review")).toBe(true);
      expect(final.every((f) => f.evidence.length === 0)).toBe(true);
      expect(result.summary?.hasCritical).toBe(false);
      expect(alerts).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it("rejects extracted obligations that cite chunks the model was not shown", async () => {
    const liar: Analyst = {
      name: "liar-stub",
      isRelevant: async () => ({ relevant: true, reason: "", costUsd: 0 }),
      extractObligations: async () => ({
        obligations: [
          { obligation: "Made-up duty.", applies_to: "everything", technical_controls: ["foo"], source_chunk_ids: [424_242] },
        ],
        costUsd: 0,
      }),
      assess: async () => {
        throw new Error("assess must not be called");
      },
    };
    const handle = await openMigratedDb({ pgliteDir: "memory" });
    try {
      const result = await runPipeline({
        trigger: "manual",
        demo: true,
        handle,
        analyst: liar,
        embedder: new LocalHashEmbedder(),
        deps: { renderReport: async () => ({ url: "memory://r", path: "memory://r" }), notify: async () => [] },
      });
      expect(result.state!.obligations).toEqual([]);
      expect(result.state!.finalFindings).toEqual([]);
      expect(result.errors.join("\n")).toContain("no valid source chunk");
    } finally {
      await handle.close();
    }
  });
});
