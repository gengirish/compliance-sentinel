import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { inArray } from "drizzle-orm";
import { openMigratedDb } from "../db/client.js";
import { rules as rulesTable } from "../db/schema.js";
import { SEVERITY_RANK, type Severity } from "../graph/types.js";
import { runPipeline } from "../pipeline/run.js";
import { renderMarkdownSummary } from "../report/markdown.js";

const { values } = parseArgs({
  options: {
    demo: { type: "boolean", default: false },
    rules: { type: "string" },
    repo: { type: "string" },
    "repo-url": { type: "string" },
    ref: { type: "string" },
    markdown: { type: "string" },
    "repo-web-url": { type: "string" },
    "fail-on": { type: "string", default: "none" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`Usage: pnpm audit:run [--demo] [--rules 1,2,3] [--repo <path> | --repo-url <url> [--ref <sha>]]
                     [--markdown <file>] [--repo-web-url <url>] [--fail-on critical|high|medium|low|none]

  (no flags)     Scrape the sources and audit any new or amended rules.
  --demo         Force the bundled demo rules through against the target repo.
  --rules        Audit rules already in the store, by id, without scraping.
  --repo         Audit the repository at this local path.
  --repo-url     Clone and audit this repository (shallow, into .data/repos/).
  --ref          Commit sha, branch or tag to check out with --repo-url.
  --markdown     Also write a Markdown summary (for a pull-request comment) to this file.
  --repo-web-url Base URL such as https://github.com/owner/name, to link file:line citations.
  --fail-on      Exit with code 1 when a violation at or above this severity is found.`);
  process.exit(0);
}

const failOn = values["fail-on"];
if (failOn !== "none" && !(failOn in SEVERITY_RANK)) {
  console.error(`--fail-on must be one of critical, high, medium, low, none (got "${failOn}")`);
  process.exit(2);
}

const ruleIds = values.rules
  ?.split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const handle = await openMigratedDb();
try {
  const result = await runPipeline({
    trigger: "manual",
    demo: values.demo,
    ruleIds,
    repoPath: values.repo,
    repoUrl: values["repo-url"],
    repoRef: values.ref,
    handle,
  });

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

    const findings = result.state?.finalFindings ?? [];
    if (values.markdown) {
      const titles = result.rulesInScope.length
        ? await handle.db
            .select({ id: rulesTable.id, title: rulesTable.title })
            .from(rulesTable)
            .where(inArray(rulesTable.id, result.rulesInScope))
        : [];
      writeFileSync(
        values.markdown,
        renderMarkdownSummary({
          findings,
          ruleTitles: new Map(titles.map((r) => [r.id, r.title])),
          repo: result.state?.repo ?? "repository",
          commitSha: result.state?.commitSha ?? "",
          analyst: result.analyst,
          costUsd: result.costUsd,
          reportUrl: result.reportUrl?.startsWith("http") ? result.reportUrl : null,
          repoWebUrl: values["repo-web-url"],
        }),
      );
      console.log(`  markdown       : ${values.markdown}`);
    }

    if (failOn !== "none") {
      const threshold = SEVERITY_RANK[failOn as Severity];
      const failing = findings.filter((f) => f.status === "violation" && SEVERITY_RANK[f.severity] <= threshold);
      if (failing.length) {
        console.log(`  result         : ${failing.length} violation(s) at or above "${failOn}"; failing`);
        process.exitCode = 1;
      }
    }
  }
} finally {
  await handle.close();
}
