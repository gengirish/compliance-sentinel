import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveFromRoot } from "../config.js";
import { openMigratedDb } from "../db/client.js";
import { PLANTED_VIOLATIONS, scoreGolden } from "../eval/golden.js";
import { FAST_MODEL, SMART_MODEL } from "../llm/claudeAnalyst.js";
import { createAnalyst, runPipeline } from "../pipeline/run.js";
import { createEmbedder } from "../rag/embed.js";

// Runs the demo rules against demo-target-app and scores the findings against the
// planted violations. Uses Claude when ANTHROPIC_API_KEY is set, otherwise the
// offline keyword baseline. An in-memory database keeps the eval self-contained.
// Each run also writes a JSON result to reports/eval/ so repeated runs can be compared.
const startedAt = new Date();
const handle = await openMigratedDb({ pgliteDir: "memory" });
try {
  main: {
    const analyst = createAnalyst();
    const embedder = createEmbedder(handle.db);
    const result = await runPipeline({
      trigger: "manual",
      demo: true,
      handle,
      analyst,
      embedder,
      deps: { notify: async () => [] },
    });
    const findings = result.state?.finalFindings ?? [];

    // A run in which every rule failed extraction (bad key, outage) scores 0% recall and a
    // vacuous 100% precision. That is not a measurement, so report the errors and stop.
    const extractionFailures = result.errors.filter((e) => e.includes("obligation extraction failed"));
    if (result.rulesInScope.length > 0 && extractionFailures.length >= result.rulesInScope.length) {
      console.error(
        `\nGolden audit aborted: obligation extraction failed for all ${result.rulesInScope.length} rules.`,
      );
      for (const e of extractionFailures.slice(0, 3)) console.error(`  ${e.slice(0, 300)}`);
      console.error("  No result was written.");
      process.exitCode = 2;
      break main;
    }

    const score = scoreGolden(findings);
    const wallSeconds = (Date.now() - startedAt.getTime()) / 1000;

    console.log(`\nGolden audit (${PLANTED_VIOLATIONS.length} planted violations)`);
    for (const planted of PLANTED_VIOLATIONS) {
      console.log(`  ${score.found.includes(planted.id) ? "FOUND " : "MISSED"}  ${planted.id}: ${planted.description}`);
    }
    console.log(
      `\n  recall    : ${(score.recall * 100).toFixed(0)}% (${score.found.length}/${PLANTED_VIOLATIONS.length})`,
    );
    console.log(`  precision : ${(score.precision * 100).toFixed(0)}% of reported violations match a planted one`);
    console.log(
      `  precision : ${(score.precisionWithConfirmedGaps * 100).toFixed(0)}% match a planted violation or a confirmed real gap`,
    );
    console.log(`  confirmed real gaps found: ${score.confirmedGaps.length ? score.confirmedGaps.join(", ") : "none"}`);
    console.log(
      `  compliant areas wrongly flagged: ${score.falselyFlagged.length ? score.falselyFlagged.join(", ") : "none"}`,
    );
    console.log(`  model cost: $${result.costUsd.toFixed(4)}`);
    for (const finding of score.unexplained) {
      console.log(`  false positive: ${finding.obligation.slice(0, 100)} @ ${finding.evidence[0]?.path ?? "?"}`);
    }

    const counts = { compliant: 0, violation: 0, needs_review: 0 };
    for (const f of findings) counts[f.status] += 1;
    const record = {
      startedAt: startedAt.toISOString(),
      wallSeconds,
      analyst: analyst.name,
      models: analyst.name === "claude" ? { assess: SMART_MODEL, fast: FAST_MODEL } : null,
      embedder: embedder.model,
      costUsd: result.costUsd,
      findings: counts,
      recall: score.recall,
      precision: score.precision,
      precisionWithConfirmedGaps: score.precisionWithConfirmedGaps,
      violations: counts.violation,
      found: score.found,
      missed: score.missed,
      confirmedGaps: score.confirmedGaps,
      falselyFlagged: score.falselyFlagged,
      falsePositives: score.unexplained.map((f) => ({
        obligation: f.obligation,
        severity: f.severity,
        evidence: f.evidence.map((e) => `${e.path}:${e.start_line}-${e.end_line}`),
        rationale: f.rationale,
      })),
      errors: result.errors,
    };
    const dir = resolveFromRoot("reports/eval");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `golden-${startedAt.toISOString().replace(/[:.]/g, "-")}-${analyst.name}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`  result    : ${path.relative(resolveFromRoot("."), file)}`);

    process.exitCode = score.missed.length || score.falselyFlagged.length ? 1 : 0;
  }
} finally {
  await handle.close();
}
