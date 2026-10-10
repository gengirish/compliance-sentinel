import { openMigratedDb } from "../db/client.js";
import { PLANTED_VIOLATIONS, scoreGolden } from "../eval/golden.js";
import { runPipeline } from "../pipeline/run.js";

// Runs the demo rules against demo-target-app and scores the findings against the
// planted violations. Uses Claude when ANTHROPIC_API_KEY is set, otherwise the
// offline keyword baseline. An in-memory database keeps the eval self-contained.
const handle = await openMigratedDb({ pgliteDir: "memory" });
try {
  const result = await runPipeline({
    trigger: "manual",
    demo: true,
    handle,
    deps: { notify: async () => [] },
  });
  const findings = result.state?.finalFindings ?? [];
  const score = scoreGolden(findings);

  console.log(`\nGolden audit (${PLANTED_VIOLATIONS.length} planted violations)`);
  for (const planted of PLANTED_VIOLATIONS) {
    console.log(`  ${score.found.includes(planted.id) ? "FOUND " : "MISSED"}  ${planted.id}: ${planted.description}`);
  }
  console.log(`\n  recall    : ${(score.recall * 100).toFixed(0)}% (${score.found.length}/${PLANTED_VIOLATIONS.length})`);
  console.log(`  precision : ${(score.precision * 100).toFixed(0)}% of reported violations match a planted one`);
  console.log(`  compliant areas wrongly flagged: ${score.falselyFlagged.length ? score.falselyFlagged.join(", ") : "none"}`);
  console.log(`  model cost: $${result.costUsd.toFixed(4)}`);
  for (const finding of score.unexpected) {
    console.log(`  unexpected violation: ${finding.obligation.slice(0, 100)} @ ${finding.evidence[0]?.path ?? "?"}`);
  }
  process.exitCode = score.missed.length || score.falselyFlagged.length ? 1 : 0;
} finally {
  await handle.close();
}
