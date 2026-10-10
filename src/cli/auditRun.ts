import { parseArgs } from "node:util";
import { runPipeline } from "../pipeline/run.js";

const { values } = parseArgs({
  options: {
    demo: { type: "boolean", default: false },
    rules: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`Usage: pnpm audit:run [--demo] [--rules 1,2,3]

  (no flags)   Scrape the sources and audit any new or amended rules.
  --demo       Force the bundled demo rules through against the target repo.
  --rules      Audit rules already in the store, by id, without scraping.`);
  process.exit(0);
}

const ruleIds = values.rules
  ?.split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const result = await runPipeline({ trigger: "manual", demo: values.demo, ruleIds });

if (result.status === "skipped") {
  console.log(`Run ${result.runId}: no new or amended rules, nothing to audit.`);
} else {
  const s = result.summary!;
  console.log(`
Run ${result.runId} completed
  rules in scope : ${result.rulesInScope.length}
  obligations    : ${result.state?.obligations.length ?? 0}
  findings       : ${s.total}
  violations     : ${s.byStatus.violation} (critical ${s.violationsBySeverity.critical}, high ${s.violationsBySeverity.high}, medium ${s.violationsBySeverity.medium}, low ${s.violationsBySeverity.low})
  needs review   : ${s.byStatus.needs_review}
  compliant      : ${s.byStatus.compliant}
  model cost     : $${result.costUsd.toFixed(4)}
  report         : ${result.reportUrl}
  alerts sent    : ${result.notified.length ? result.notified.join(", ") : "none (dry run or no critical findings)"}`);
  if (result.errors.length) console.log(`  run notes      :\n    - ${result.errors.join("\n    - ")}`);
}
