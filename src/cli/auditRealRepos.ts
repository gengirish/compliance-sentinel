import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config, resolveFromRoot } from "../config.js";
import { openMigratedDb } from "../db/client.js";
import { createAnalyst, repoNameFromUrl, runPipeline } from "../pipeline/run.js";
import { createEmbedder } from "../rag/embed.js";

// Audits the public repositories listed in samples/real/repos.json at their pinned commits
// and writes, per repo, the report, a summary and a labelling sheet under samples/real/<owner>__<name>/.
// The labels are filled in by hand afterwards: each violation is a true or false positive.
// Refuses to run on the offline baseline unless --allow-offline, because offline results on
// real code say nothing about the product and must not be published as if they did.

type RepoEntry = { url: string; ref: string; license: string; why: string };
type Label = "true_positive" | "false_positive" | "useful" | "noise" | null;

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    "allow-offline": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`Usage: pnpm audit:real [--only owner/name] [--allow-offline]

  Audits each repo in samples/real/repos.json with the bundled demo rules, using an
  in-memory database, and writes report.html, summary.json and labels.json per repo.`);
  process.exit(0);
}

const analyst = createAnalyst();
if (analyst.name !== "claude" && !values["allow-offline"]) {
  console.error("ANTHROPIC_API_KEY is not set or not usable: refusing to publish offline results on real repositories.");
  console.error("Pass --allow-offline to exercise the plumbing; the output then goes to reports/real-offline/.");
  process.exit(2);
}
if (!config.VOYAGE_API_KEY) console.warn("VOYAGE_API_KEY is not set: retrieval uses the local hash embedder.");

const repos = JSON.parse(readFileSync(resolveFromRoot("samples/real/repos.json"), "utf8")) as RepoEntry[];
const outRoot = resolveFromRoot(analyst.name === "claude" ? "samples/real" : "reports/real-offline");
const rows: string[] = [];

for (const entry of repos) {
  const name = repoNameFromUrl(entry.url);
  if (values.only && values.only !== name) continue;
  const outDir = path.join(outRoot, name.replace("/", "__"));
  mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  // A fresh in-memory database per repo keeps runs independent and leaves the shared database untouched.
  const handle = await openMigratedDb({ pgliteDir: "memory" });
  try {
    const result = await runPipeline({
      trigger: "manual",
      demo: true,
      handle,
      analyst,
      embedder: createEmbedder(handle.db),
      repoUrl: entry.url,
      repoRef: entry.ref,
      deps: { notify: async () => [] },
    });
    const findings = result.state?.finalFindings ?? [];
    const wallSeconds = Math.round((Date.now() - started) / 1000);
    const summary = {
      repo: name,
      ref: entry.ref,
      license: entry.license,
      analyst: analyst.name,
      embedder: createEmbedder().model,
      auditedAt: new Date().toISOString(),
      wallSeconds,
      costUsd: result.costUsd,
      obligations: result.state?.obligations.length ?? 0,
      findings: result.summary,
      errors: result.errors,
    };
    writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

    // Keep labels already written by hand: only add findings that are not in the sheet yet.
    const labelsFile = path.join(outDir, "labels.json");
    const existing = existsSync(labelsFile)
      ? (JSON.parse(readFileSync(labelsFile, "utf8")) as { key: string; label: Label; note: string }[])
      : [];
    const byKey = new Map(existing.map((l) => [l.key, l]));
    const labels = findings
      .filter((f) => f.status !== "compliant")
      .map((f) => {
        const where = f.evidence.map((e) => `${e.path}:${e.start_line}-${e.end_line}`);
        const key = `${f.status}|${f.obligation}|${where.join(",")}`;
        return {
          key,
          status: f.status,
          severity: f.severity,
          obligation: f.obligation,
          evidence: where,
          rationale: f.rationale,
          label: byKey.get(key)?.label ?? null,
          note: byKey.get(key)?.note ?? "",
        };
      });
    writeFileSync(labelsFile, `${JSON.stringify(labels, null, 2)}\n`);

    if (result.reportPath && existsSync(result.reportPath)) {
      copyFileSync(result.reportPath, path.join(outDir, `report${path.extname(result.reportPath)}`));
      const html = result.reportPath.replace(/\.pdf$/, ".html");
      if (html !== result.reportPath && existsSync(html)) copyFileSync(html, path.join(outDir, "report.html"));
    }
    const s = result.summary;
    rows.push(
      `| ${name} | ${entry.ref.slice(0, 7)} | ${summary.obligations} | ${s?.byStatus.violation ?? 0} | ${s?.byStatus.needs_review ?? 0} | ${s?.byStatus.compliant ?? 0} | $${result.costUsd.toFixed(2)} | ${wallSeconds}s |`,
    );
    console.log(`${name}: done -> ${path.relative(resolveFromRoot("."), outDir)}`);
  } catch (err) {
    console.error(`${name}: failed: ${err instanceof Error ? err.message : String(err)}`);
    rows.push(`| ${name} | ${entry.ref.slice(0, 7)} | failed | | | | | |`);
  } finally {
    await handle.close();
  }
}

console.log(`
| Repo | Commit | Obligations | Violations | Needs review | Compliant | Cost | Wall time |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}`);
