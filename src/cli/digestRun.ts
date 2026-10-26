import { parseArgs } from "node:util";
import { buildDigestMarkdown, deliverDigest } from "../digest/deliver.js";
import { runWeeklyDigest } from "../digest/weekly.js";
import { runPipeline } from "../pipeline/run.js";

const { values } = parseArgs({
  options: {
    demo: { type: "boolean", default: false },
    days: { type: "string" },
    send: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`Usage: pnpm digest:run [--days 7] [--send] | pnpm digest:run --demo [--send]

  (no flags)   Digest every tracked rule whose text changed in the last --days days (default 7).
  --demo       Run the pipeline in digest mode on the bundled demo rules instead.
  --send       Deliver the digest by email (AgentMail) and Slack, when configured.`);
  process.exit(0);
}

if (values.demo) {
  const result = await runPipeline({ trigger: "manual", demo: true, mode: "digest" });
  const today = new Date().toISOString().slice(0, 10);
  const report = { from: today, to: today, records: result.digests, costUsd: result.costUsd };
  console.log(buildDigestMarkdown(report));
  console.log(`\nRun ${result.runId}: ${result.digests.length} rule(s) digested, model cost $${result.costUsd.toFixed(4)}`);
  if (result.errors.length) console.log(`  run notes:\n    - ${result.errors.join("\n    - ")}`);
  if (values.send) console.log(`  delivered: ${(await deliverDigest(report)).join(", ") || "none (dry run)"}`);
} else {
  const days = values.days ? Number(values.days) : undefined;
  const result = await runWeeklyDigest({ days, send: values.send });
  console.log(buildDigestMarkdown(result));
  console.log(`\n${result.records.length} rule(s) digested, ${result.records.filter((r) => r.reused).length} reused, model cost $${result.costUsd.toFixed(4)}`);
  console.log(`  delivered: ${result.notified.join(", ") || (values.send ? "none (dry run)" : "not sent (pass --send)")}`);
  if (result.errors.length) console.log(`  notes:\n    - ${result.errors.join("\n    - ")}`);
}
