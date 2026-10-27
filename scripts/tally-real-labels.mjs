// Prints a Markdown table of the labels in samples/real/*/labels.json, joined with each summary.json.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve("samples/real");
const rows = [];
const totals = { violations: 0, tp: 0, fp: 0, unlabelled: 0, review: 0, useful: 0, noise: 0, cost: 0 };

for (const dir of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const labelsFile = path.join(root, dir.name, "labels.json");
  const summaryFile = path.join(root, dir.name, "summary.json");
  if (!existsSync(labelsFile) || !existsSync(summaryFile)) continue;
  const labels = JSON.parse(readFileSync(labelsFile, "utf8"));
  const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
  const v = labels.filter((l) => l.status === "violation");
  const r = labels.filter((l) => l.status === "needs_review");
  const t = {
    violations: v.length,
    tp: v.filter((l) => l.label === "true_positive").length,
    fp: v.filter((l) => l.label === "false_positive").length,
    unlabelled: labels.filter((l) => l.label == null).length,
    review: r.length,
    useful: r.filter((l) => l.label === "useful").length,
    noise: r.filter((l) => l.label === "noise").length,
    cost: summary.costUsd,
  };
  for (const k of Object.keys(totals)) totals[k] += t[k];
  const precision = t.violations ? `${Math.round((t.tp / t.violations) * 100)}%` : "n/a";
  rows.push(
    `| ${summary.repo} | \`${summary.ref.slice(0, 7)}\` | ${t.violations} | ${t.tp} | ${t.fp} | ${precision} | ${t.review} | ${t.useful} | ${t.noise} | $${t.cost.toFixed(2)} |`,
  );
}

const precision = totals.violations ? `${Math.round((totals.tp / totals.violations) * 100)}%` : "n/a";
console.log(`| Repo | Commit | Violations | True positives | False positives | Precision | Needs review | Useful | Noise | Cost |
|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}
| **Total** | | ${totals.violations} | ${totals.tp} | ${totals.fp} | ${precision} | ${totals.review} | ${totals.useful} | ${totals.noise} | $${totals.cost.toFixed(2)} |`);
if (totals.unlabelled) console.log(`\n${totals.unlabelled} finding(s) are not labelled yet.`);
