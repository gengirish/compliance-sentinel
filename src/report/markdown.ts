import { SEVERITY_RANK, summarize, type Finding } from "../graph/types.js";

export type MarkdownInput = {
  findings: Finding[];
  /** Rule id -> title, for the "Rule" column. */
  ruleTitles: Map<number, string>;
  repo: string;
  commitSha: string;
  analyst: string;
  costUsd: number;
  /** Link to the full report, when one was uploaded. */
  reportUrl?: string | null;
  /** e.g. "https://github.com/owner/name"; turns file:line citations into links at the audited commit. */
  repoWebUrl?: string;
  /** How many violations to list in full; the rest are counted. */
  maxFindings?: number;
};

/** HTML comment that marks the comment as ours, so a re-run can find and update it instead of posting again. */
export const COMMENT_MARKER = "<!-- compliance-sentinel-report -->";

const SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const;

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function location(e: Finding["evidence"][number], input: MarkdownInput): string {
  const range = e.end_line > e.start_line ? `${e.start_line}-${e.end_line}` : `${e.start_line}`;
  const label = `${e.path}:${range}`;
  if (!input.repoWebUrl || input.commitSha.startsWith("content-")) return `\`${label}\``;
  const anchor = e.end_line > e.start_line ? `#L${e.start_line}-L${e.end_line}` : `#L${e.start_line}`;
  return `[\`${label}\`](${input.repoWebUrl}/blob/${input.commitSha}/${e.path}${anchor})`;
}

/**
 * A short Markdown summary of an audit for a pull-request comment or a check run:
 * counts, then the most severe violations with their regulation and code citations.
 */
export function renderMarkdownSummary(input: MarkdownInput): string {
  const summary = summarize(input.findings);
  const max = input.maxFindings ?? 10;
  const violations = input.findings
    .filter((f) => f.status === "violation")
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const shown = violations.slice(0, max);
  const sha = input.commitSha.startsWith("content-") ? "working tree" : `\`${input.commitSha.slice(0, 7)}\``;

  const lines: string[] = [
    COMMENT_MARKER,
    "## Compliance Sentinel",
    "",
    `Audited **${input.repo}** at ${sha} against ${input.ruleTitles.size} rule${input.ruleTitles.size === 1 ? "" : "s"}.`,
    "",
    "| Violations | Critical | High | Needs review | Compliant |",
    "|---|---|---|---|---|",
    `| ${summary.byStatus.violation} | ${summary.violationsBySeverity.critical} | ${summary.violationsBySeverity.high} | ${summary.byStatus.needs_review} | ${summary.byStatus.compliant} |`,
    "",
  ];

  if (shown.length === 0) {
    lines.push("No violations found.", "");
  } else {
    lines.push("| Severity | Obligation | Rule | Code |", "|---|---|---|---|");
    for (const f of shown) {
      const code = f.evidence.slice(0, 2).map((e) => location(e, input)).join("<br>") || "none";
      lines.push(
        `| ${SEVERITY_LABEL[f.severity]} | ${escapeCell(shorten(f.obligation, 160))} | ${escapeCell(shorten(input.ruleTitles.get(f.ruleId) ?? `rule ${f.ruleId}`, 70))} | ${code} |`,
      );
    }
    lines.push("");
    if (violations.length > shown.length) {
      lines.push(`${violations.length - shown.length} more violation(s) are in the full report.`, "");
    }
  }

  if (input.reportUrl) lines.push(`[Full report with citations](${input.reportUrl})`, "");
  const analyst =
    input.analyst === "claude"
      ? "Claude"
      : `the offline keyword baseline (no \`ANTHROPIC_API_KEY\` was given, so only catalogue controls were checked)`;
  lines.push(
    `<sub>Assessed by ${analyst}. Model cost $${input.costUsd.toFixed(2)}. Decision support, not legal advice: findings do not guarantee compliance or complete coverage of any regulation.</sub>`,
  );
  return `${lines.join("\n")}\n`;
}
