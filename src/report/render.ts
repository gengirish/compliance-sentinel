import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq, inArray } from "drizzle-orm";
import Handlebars from "handlebars";
import { config, resolveFromRoot } from "../config.js";
import type { Db } from "../db/client.js";
import { ruleChunks, rules, sources } from "../db/schema.js";
import type { AuditStateType, ReportResult } from "../graph/state.js";
import { summarize, type Finding } from "../graph/types.js";
import { errorMessage, log } from "../log.js";
import { storeReport } from "./upload.js";

const run = promisify(execFile);
const TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "template.html");

const BADGE_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  compliant: "Compliant",
  needs_review: "Needs review",
};

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export type ReportInput = Pick<
  AuditStateType,
  "runId" | "trigger" | "ruleIds" | "repo" | "commitSha" | "finalFindings" | "errors" | "costUsd"
> & { analyst: string; date?: Date };

/** Joins findings with rule and chunk text into the view model the template renders. */
export async function buildReportData(db: Db, input: ReportInput) {
  const ruleRows = input.ruleIds.length
    ? await db
        .select({
          id: rules.id,
          title: rules.title,
          url: rules.url,
          effectiveDate: rules.effectiveDate,
          externalId: rules.externalId,
          source: sources.name,
        })
        .from(rules)
        .innerJoin(sources, eq(rules.sourceId, sources.id))
        .where(inArray(rules.id, input.ruleIds))
    : [];
  const ruleById = new Map(ruleRows.map((r) => [r.id, r]));

  const chunkIds = [...new Set(input.finalFindings.flatMap((f) => f.citationChunkIds))];
  const chunkRows = chunkIds.length
    ? await db
        .select({ id: ruleChunks.id, sectionRef: ruleChunks.sectionRef, text: ruleChunks.text })
        .from(ruleChunks)
        .where(inArray(ruleChunks.id, chunkIds))
    : [];
  const chunkById = new Map(chunkRows.map((c) => [c.id, c]));

  const view = (finding: Finding, index: number) => {
    const rule = ruleById.get(finding.ruleId);
    const badge = finding.status === "violation" ? finding.severity : finding.status;
    const primary = finding.evidence[0];
    return {
      number: index + 1,
      status: finding.status,
      badge,
      badgeLabel: BADGE_LABEL[badge] ?? badge,
      obligation: finding.obligation,
      rationale: finding.rationale,
      verification: finding.verification,
      primaryLocation: primary ? `${primary.path}:${primary.start_line}` : "none",
      rule: {
        title: rule?.title ?? `Rule ${finding.ruleId}`,
        shortTitle: truncate(rule?.title ?? `Rule ${finding.ruleId}`, 70),
        url: rule?.url ?? "",
        effectiveDate: rule?.effectiveDate ?? "",
      },
      citations: finding.citationChunkIds.flatMap((id) => {
        const chunk = chunkById.get(id);
        return chunk ? [{ id, sectionRef: chunk.sectionRef ?? "Rule text", excerpt: truncate(chunk.text, 520) }] : [];
      }),
      evidence: finding.evidence.map((e) => ({
        path: e.path,
        lines: e.start_line === e.end_line ? `${e.start_line}` : `${e.start_line}-${e.end_line}`,
        excerpt: e.excerpt,
      })),
    };
  };

  const findings = input.finalFindings.map(view);
  const pick = (predicate: (f: (typeof findings)[number]) => boolean) => findings.filter(predicate);
  const groups = [
    { title: "Critical violations", intro: "", findings: pick((f) => f.badge === "critical") },
    { title: "High severity violations", intro: "", findings: pick((f) => f.badge === "high") },
    { title: "Medium severity violations", intro: "", findings: pick((f) => f.badge === "medium") },
    { title: "Low severity violations", intro: "", findings: pick((f) => f.badge === "low") },
    {
      title: "Needs human review",
      intro: "The evidence was missing, ambiguous or failed citation checks. A person should assess these.",
      findings: pick((f) => f.status === "needs_review"),
    },
    {
      title: "Compliant",
      intro: "Supporting code was found for these obligations.",
      findings: pick((f) => f.status === "compliant"),
    },
  ].filter((group) => group.findings.length > 0);

  const date = input.date ?? new Date();
  return {
    run: {
      id: input.runId,
      date: date.toISOString().slice(0, 10),
      trigger: input.trigger,
      repo: input.repo,
      commitSha: input.commitSha,
      analyst: input.analyst,
      costUsd: input.costUsd.toFixed(4),
    },
    summary: summarize(input.finalFindings),
    findings,
    groups,
    rules: ruleRows.map((r) => ({ ...r, effectiveDate: r.effectiveDate ?? "not stated" })),
    errors: input.errors,
  };
}

let compiled: Handlebars.TemplateDelegate | undefined;

export function renderHtml(data: Awaited<ReturnType<typeof buildReportData>>): string {
  if (!compiled) {
    const hb = Handlebars.create();
    hb.registerHelper("plural", (count: number) => (count === 1 ? "" : "s"));
    compiled = hb.compile(readFileSync(TEMPLATE_PATH, "utf8"));
  }
  return compiled(data);
}

/** Runs the WeasyPrint CLI. Throws when the binary is missing or exits non-zero. */
export async function htmlToPdf(htmlPath: string, pdfPath: string): Promise<void> {
  await run(config.WEASYPRINT_BIN, [htmlPath, pdfPath], { timeout: 120_000 });
}

/**
 * Renders the report to `reports/run-<id>.html`, converts it to PDF with
 * WeasyPrint and stores it. Without WeasyPrint (local dev on a machine lacking
 * Pango/Cairo) the HTML is kept as the report, unless REQUIRE_PDF is set, as it
 * is in the Docker image.
 */
export async function renderReport(db: Db, input: ReportInput): Promise<ReportResult> {
  const dir = resolveFromRoot(config.REPORTS_DIR);
  mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, `run-${input.runId}.html`);
  const pdfPath = path.join(dir, `run-${input.runId}.pdf`);

  writeFileSync(htmlPath, renderHtml(await buildReportData(db, input)), "utf8");

  let finalPath = pdfPath;
  try {
    await htmlToPdf(htmlPath, pdfPath);
  } catch (err) {
    if (process.env.REQUIRE_PDF === "true") {
      throw new Error(`WeasyPrint failed: ${errorMessage(err)}`);
    }
    log.warn("WeasyPrint unavailable, keeping the HTML report", { error: errorMessage(err).slice(0, 300) });
    finalPath = htmlPath;
  }
  return storeReport(finalPath, input.runId);
}
