import { z } from "zod";
import type { CodeEvidence } from "../db/schema.js";

export const STATUSES = ["compliant", "violation", "needs_review"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Status = (typeof STATUSES)[number];
export type Severity = (typeof SEVERITIES)[number];

/** What the model returns when it reads a rule. */
export const ObligationDraftSchema = z.object({
  obligation: z.string().describe("One concrete duty the rule imposes, in a single sentence."),
  applies_to: z.string().describe("Who or what the duty applies to, e.g. 'systems storing customer information'."),
  technical_controls: z
    .array(z.string())
    .describe(
      "3-8 short code-search keywords or identifiers that would reveal whether a codebase implements or violates this duty, e.g. 'console.log', 'retention', 'consent'.",
    ),
  source_chunk_ids: z.array(z.number().int()).describe("Ids of the rule chunks that state this duty."),
});
export const ObligationListSchema = z.object({ obligations: z.array(ObligationDraftSchema) });
export type ObligationDraft = z.infer<typeof ObligationDraftSchema>;

export type Obligation = {
  /** Stable within a run: `${ruleId}-${index}`. */
  id: string;
  ruleId: number;
  obligation: string;
  appliesTo: string;
  technicalControls: string[];
  sourceChunkIds: number[];
  /** Set by the offline analyst: the catalogue control this obligation maps to. */
  controlId?: string;
};

/** What the model returns when it judges one obligation against code evidence. */
export const AssessmentSchema = z.object({
  status: z.enum(STATUSES),
  severity: z.enum(SEVERITIES).describe("Impact if this is a violation. Use 'low' for compliant findings."),
  rationale: z.string().describe("Two to four sentences tying the regulation text to the cited code."),
  evidence: z
    .array(
      z.object({
        path: z.string(),
        start_line: z.number().int(),
        end_line: z.number().int(),
      }),
    )
    .describe("Code locations, copied from the evidence provided. Never invent a path or line."),
  citation_chunk_ids: z.array(z.number().int()).describe("Ids of the rule chunks relied on."),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const RelevanceSchema = z.object({
  relevant: z.boolean().describe("True when the rule imposes duties that software or data-handling systems must implement."),
  reason: z.string(),
});

export type RuleChunkRef = { id: number; ruleId: number; sectionRef: string | null; text: string };

/** A slice of the audited repository shown to the analyst. Lines are 1-based and inclusive. */
export type EvidenceSnippet = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  via: "keyword" | "vector";
};

export type Finding = {
  ruleId: number;
  obligationId: string;
  obligation: string;
  status: Status;
  severity: Severity;
  rationale: string;
  evidence: CodeEvidence[];
  citationChunkIds: number[];
  /** Notes added by deterministic verification, e.g. a dropped citation. */
  verification: string[];
};

export type FindingSummary = {
  total: number;
  byStatus: Record<Status, number>;
  violationsBySeverity: Record<Severity, number>;
  hasCritical: boolean;
};

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function summarize(findings: Finding[]): FindingSummary {
  const byStatus: Record<Status, number> = { compliant: 0, violation: 0, needs_review: 0 };
  const violationsBySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    byStatus[finding.status]++;
    if (finding.status === "violation") violationsBySeverity[finding.severity]++;
  }
  return {
    total: findings.length,
    byStatus,
    violationsBySeverity,
    hasCritical: violationsBySeverity.critical > 0,
  };
}
