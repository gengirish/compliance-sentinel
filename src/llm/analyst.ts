import type { Rule } from "../db/schema.js";
import type { Assessment, EvidenceSnippet, Obligation, ObligationDraft, RuleChunkRef } from "../graph/types.js";

export type AssessInput = {
  rule: Rule;
  obligation: Obligation;
  ruleChunks: RuleChunkRef[];
  evidence: EvidenceSnippet[];
};

/**
 * The reasoning steps of the audit. `ClaudeAnalyst` is the real implementation;
 * `OfflineAnalyst` is a keyword baseline for runs without an API key.
 */
export interface Analyst {
  readonly name: string;
  /** Cheap pre-filter: does this rule impose duties on software or data handling at all? */
  isRelevant(rule: Rule, chunks: RuleChunkRef[]): Promise<{ relevant: boolean; reason: string; costUsd: number }>;
  extractObligations(
    rule: Rule,
    chunks: RuleChunkRef[],
  ): Promise<{ obligations: (ObligationDraft & { controlId?: string })[]; costUsd: number }>;
  assess(input: AssessInput): Promise<{ assessment: Assessment; costUsd: number }>;
}

/** Tracks spend against the per-run cap shared by every node in a run. */
export class Budget {
  private spentUsd = 0;
  constructor(readonly maxUsd: number) {}

  add(costUsd: number): void {
    this.spentUsd += costUsd;
  }
  get spent(): number {
    return this.spentUsd;
  }
  get exceeded(): boolean {
    return this.spentUsd >= this.maxUsd;
  }
}

export function formatEvidence(evidence: EvidenceSnippet[]): string {
  return evidence
    .map((snippet) => {
      const numbered = snippet.text
        .split("\n")
        .map((line, i) => `${String(snippet.startLine + i).padStart(4)} | ${line}`)
        .join("\n");
      return `--- ${snippet.path} (lines ${snippet.startLine}-${snippet.endLine})\n${numbered}`;
    })
    .join("\n\n");
}

export function formatRuleChunks(chunks: RuleChunkRef[]): string {
  return chunks
    .map((chunk) => `[chunk ${chunk.id}${chunk.sectionRef ? ` | ${chunk.sectionRef}` : ""}]\n${chunk.text}`)
    .join("\n\n");
}
