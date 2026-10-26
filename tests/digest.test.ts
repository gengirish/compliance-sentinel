import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { auditRuns, rules } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { buildDigestEmail, buildDigestMarkdown, buildDigestSlack, deliverDigest, type DigestReport } from "../src/digest/deliver.js";
import { digestRule, rulesChangedSince, type RuleDigestRecord } from "../src/digest/digestRule.js";
import { changedLines, formatChangedLines, sentences } from "../src/digest/textDiff.js";
import { runWeeklyDigest } from "../src/digest/weekly.js";
import { OfflineAnalyst } from "../src/llm/offlineAnalyst.js";
import { LocalHashEmbedder } from "../src/rag/embed.js";
import { DIGEST_NOTE, loadDemoRules, runPipeline } from "../src/pipeline/run.js";
import { processAuditJob } from "../src/queue/worker.js";
import { persistChanges, upsertSource } from "../src/scrape/diff.js";

describe("text diff helpers", () => {
  it("lists lines that appear in only one version, once each, in order", () => {
    const diff = changedLines("a\nb\nc\nc", "a\nB\nc\nd\nd");
    expect(diff).toEqual({ added: ["B", "d"], removed: ["b"] });
    expect(formatChangedLines(diff)).toBe("- b\n+ B\n+ d");
    expect(formatChangedLines(diff, 8)).toBe("- b\n… 2 more changed line(s) omitted");
    expect(changedLines("same  text", "same text")).toEqual({ added: [], removed: [] });
  });

  it("splits sentences and keeps list lines separate", () => {
    expect(sentences("First duty. Second (one) here.\n- a bullet\nThird")).toEqual(["First duty.", "Second (one) here.", "- a bullet", "Third"]);
  });
});

describe("offline digest", () => {
  it("summarises a rule from its text: opening sentences, duties, effective date and audience", async () => {
    const sec = loadDemoRules().find((s) => s.def.name === "sec-demo")!.rules[0]!;
    const analyst = new OfflineAnalyst();
    const { digest, costUsd } = await analyst.digest({
      rule: { id: 1, sourceId: 1, contentHash: "x", previousRawText: null, firstSeenAt: new Date(), lastChangedAt: new Date(), ...sec },
      kind: "new",
      previousText: null,
    });
    expect(costUsd).toBe(0);
    expect(digest.effective_date).toBe("2024-08-02");
    expect(digest.what_changed.startsWith("New rule.")).toBe(true);
    expect(digest.key_obligations.length).toBeGreaterThanOrEqual(3);
    expect(digest.key_obligations.length).toBeLessThanOrEqual(8);
    expect(digest.key_obligations.some((d) => /30 days/.test(d))).toBe(true);
    expect(digest.summary).not.toMatch(/^Abridged/);
    expect(digest.applies_to).toMatch(/covered institution/i);
  });

  it("describes an amendment by its changed lines", async () => {
    const analyst = new OfflineAnalyst();
    const previous = "Firms must keep records for five years.\nFirms must notify the regulator.";
    const current = "Firms must keep records for seven years.\nFirms must notify the regulator.";
    const { digest } = await analyst.digest({
      rule: { id: 2, sourceId: 1, externalId: "r", title: "Records rule", effectiveDate: null, url: "https://x.test/r", contentHash: "y", rawText: current, previousRawText: previous, firstSeenAt: new Date(), lastChangedAt: new Date() },
      kind: "amended",
      previousText: previous,
    });
    expect(digest.what_changed).toContain("1 line(s) added and 1 removed");
    expect(digest.what_changed).toContain("seven years");
    expect(digest.effective_date).toBeNull();
  });
});

describe("digest storage and the weekly round-up", () => {
  let handle: DbHandle;
  const analyst = new OfflineAnalyst();

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
  });
  afterAll(() => handle.close());

  it("keeps the previous text when a rule is amended", async () => {
    const sourceId = await upsertSource(handle.db, { name: "diff-test", kind: "fixture", url: "https://x.test" });
    const v1 = { externalId: "R1", title: "Rule", effectiveDate: null, url: "https://x.test/r1", rawText: "Keep records for five years." };
    await persistChanges(handle.db, sourceId, [v1]);
    const second = await persistChanges(handle.db, sourceId, [{ ...v1, rawText: "Keep records for seven years." }]);
    expect(second.changes[0]?.kind).toBe("amended");
    expect(second.changed[0]?.previousRawText).toBe("Keep records for five years.");
    expect(second.changed[0]?.rawText).toBe("Keep records for seven years.");
  });

  it("runs the pipeline in digest mode: one digest per rule, no report, a note on the run", async () => {
    const result = await runPipeline({
      trigger: "manual",
      demo: true,
      mode: "digest",
      handle,
      analyst,
      embedder: new LocalHashEmbedder(),
      deps: { renderReport: async () => ({ url: "unused", path: "unused" }), notify: async () => [] },
    });
    expect(result.status).toBe("completed");
    expect(result.digests).toHaveLength(5);
    expect(result.summary).toBeNull();
    expect(result.reportUrl).toBeNull();
    expect(result.digests.every((d) => d.kind === "new" && !d.reused && d.digest.key_obligations.length > 0)).toBe(true);
    const [run] = await handle.db.select().from(auditRuns).where(eq(auditRuns.id, result.runId));
    expect(run?.note).toBe(DIGEST_NOTE);
    expect(run?.status).toBe("completed");

    // The same version is never digested twice.
    const [rule] = await handle.db.select().from(rules).where(eq(rules.id, result.digests[0]!.ruleId));
    const again = await digestRule(handle.db, analyst, rule!);
    expect(again.reused).toBe(true);
    expect(again.digest).toEqual(result.digests[0]!.digest);
  });

  it("selects rules changed inside the window and builds the weekly digest without a scrape", async () => {
    const recent = await rulesChangedSince(handle.db, new Date(Date.now() - 60_000));
    expect(recent.length).toBeGreaterThanOrEqual(6);
    expect(recent[0]?.sourceName).toBeTruthy();
    expect(await rulesChangedSince(handle.db, new Date(Date.now() + 60_000))).toEqual([]);

    const deliver = vi.fn(async () => ["email"]);
    const weekly = await runWeeklyDigest({ handle, analyst, days: 1, send: true, deliver });
    expect(weekly.records.length).toBe(recent.length);
    expect(weekly.records.filter((r) => r.reused).length).toBeGreaterThanOrEqual(5);
    expect(weekly.records.find((r) => r.title === "Rule")?.kind).toBe("amended");
    expect(weekly.notified).toEqual(["email"]);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ records: weekly.records }));
    const quiet = await runWeeklyDigest({ handle, analyst, days: 1, now: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) });
    expect(quiet.records).toEqual([]);
  });
});

describe("digest delivery", () => {
  const record = (overrides: Partial<RuleDigestRecord> = {}): RuleDigestRecord => ({
    ruleId: 1,
    source: "fca",
    title: "PS99/1: Operational resilience",
    url: "https://www.fca.org.uk/ps99-1",
    effectiveDate: "2027-03-31",
    kind: "new",
    changedAt: "2026-10-26T00:00:00.000Z",
    digest: {
      summary: "Firms must identify important business services & set tolerances.",
      what_changed: "New rule. Introduces impact tolerances.",
      effective_date: "2027-03-31",
      applies_to: "UK-authorised firms",
      key_obligations: ["Identify important business services.", "Set an impact tolerance for each."],
    },
    reused: false,
    costUsd: 0,
    ...overrides,
  });
  const report: DigestReport = {
    from: "2026-10-19",
    to: "2026-10-26",
    records: [record(), record({ ruleId: 2, source: "sec", title: "Regulation S-P", kind: "amended", url: "https://sec.test/sp" })],
    costUsd: 0.01,
  };

  it("renders markdown, email and Slack with every rule grouped by source", () => {
    const md = buildDigestMarkdown(report);
    expect(md).toContain("# Regulatory digest, 2026-10-19 to 2026-10-26: 2 rule changes (1 amended)");
    expect(md).toContain("## fca");
    expect(md).toContain("## sec");
    expect(md).toContain("- Identify important business services.");
    const email = buildDigestEmail(report);
    expect(email.subject).toBe("[Compliance Sentinel] Regulatory digest, 2026-10-19 to 2026-10-26: 2 rule changes (1 amended)");
    expect(email.html).toContain("&amp; set tolerances");
    expect(email.html).toContain('<a href="https://sec.test/sp">Regulation S-P</a>');
    expect(email.html).toContain("Amended · effective");
    expect(email.text).toBe(md);
    const slack = buildDigestSlack(report);
    expect(JSON.stringify(slack.blocks)).toContain("<https://www.fca.org.uk/ps99-1|PS99/1: Operational resilience>");
    expect(buildDigestMarkdown({ ...report, records: [] })).toContain("No tracked rule was added or amended");
  });

  it("is a dry run when neither email nor Slack is configured", async () => {
    expect(await deliverDigest(report, { mail: null })).toEqual([]);
  });

  it("routes a digest job in the worker to the weekly digest, sending it", async () => {
    const digestRunner = vi.fn(async () => ({ from: "a", to: "b", records: [record()], costUsd: 0.02, notified: ["email"], errors: [] }));
    const runner = vi.fn();
    const summary = await processAuditJob({ trigger: "cron", kind: "digest" }, runner as never, digestRunner as never);
    expect(runner).not.toHaveBeenCalled();
    expect(digestRunner).toHaveBeenCalledWith(expect.objectContaining({ send: true }));
    expect(summary).toMatchObject({ runId: 0, status: "completed", notified: ["email"], digested: 1, costUsd: 0.02 });
  });
});
