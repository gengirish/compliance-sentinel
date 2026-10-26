import type { Rule } from "../db/schema.js";
import { changedLines, sentences } from "../digest/textDiff.js";
import { CONTROLS, controlById, controlsForText, type Control } from "../graph/controls.js";
import type { Assessment, RuleChunkRef, RuleDigest } from "../graph/types.js";
import type { Analyst, AssessInput, DigestInput } from "./analyst.js";

const DATE_PHRASE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2} [A-Z][a-z]+ \d{4}|[A-Z][a-z]+ \d{1,2}, \d{4})\b/;
const DUTY = /\b(must|shall|is required to|are required to|may not|must not|shall not|is prohibited|should)\b/i;
const SKIP = /^(abridged|consult the official|this is decision support)/i;

type LineHit = { path: string; line: number };

function matchLines(input: AssessInput, patterns: RegExp[]): LineHit[] {
  const hits = new Map<string, LineHit>();
  for (const snippet of input.evidence) {
    snippet.text.split("\n").forEach((text, i) => {
      if (patterns.some((p) => p.test(text))) {
        const hit = { path: snippet.path, line: snippet.startLine + i };
        hits.set(`${hit.path}:${hit.line}`, hit);
      }
    });
  }
  return [...hits.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/** Collapses adjacent line hits in a file into ranges. */
function toRanges(hits: LineHit[], limit = 6): Assessment["evidence"] {
  const ranges: Assessment["evidence"] = [];
  for (const hit of hits) {
    const last = ranges[ranges.length - 1];
    if (last && last.path === hit.path && hit.line <= last.end_line + 1) last.end_line = hit.line;
    else ranges.push({ path: hit.path, start_line: hit.line, end_line: hit.line });
  }
  return ranges.slice(0, limit);
}

/**
 * Keyword baseline with no model behind it. It maps regulation text to the
 * control catalogue and judges code by pattern matching. It exists so the
 * pipeline, tests and demos run without an API key; it only recognises the
 * controls in the catalogue and cannot reason about anything else.
 */
export class OfflineAnalyst implements Analyst {
  readonly name = "offline-keyword-baseline";

  /**
   * A digest by pattern matching: the opening sentences, duty-shaped sentences
   * as obligations, and the first date phrase near "effective" or "apply".
   */
  async digest(input: DigestInput): Promise<{ digest: RuleDigest; costUsd: number }> {
    const text = input.rule.rawText;
    const all = sentences(text).filter((s) => !SKIP.test(s));
    const duties = [...new Set(all.filter((s) => DUTY.test(s) && s.length > 25))].slice(0, 8).map((s) => (s.length > 220 ? `${s.slice(0, 217)}…` : s));
    const effectiveMatch = text.match(new RegExp(`(?:effective|applies?|apply|in force|takes effect|compliance date)[^.\\n]{0,60}?${DATE_PHRASE.source}`, "i"));
    const appliesMatch = all.find((s) => /\b(applies to|apply to|relevant to|is for|covered institution|relevant entity|a firm must)\b/i.test(s));
    let whatChanged = `New rule. ${all[0] ?? input.rule.title}`;
    if (input.kind === "amended") {
      const diff = input.previousText ? changedLines(input.previousText, text) : { added: [], removed: [] };
      const sample = diff.added[0] ?? diff.removed[0];
      whatChanged = `Amended: ${diff.added.length} line(s) added and ${diff.removed.length} removed since the previous version.${sample ? ` For example: "${sample.slice(0, 160)}"` : ""}`;
    }
    return {
      digest: {
        summary: all.slice(0, 2).join(" ").slice(0, 400) || input.rule.title,
        what_changed: whatChanged,
        effective_date: input.rule.effectiveDate ?? effectiveMatch?.[1] ?? null,
        applies_to: appliesMatch ? appliesMatch.slice(0, 200) : "Not stated in the text (offline baseline).",
        key_obligations: duties,
      },
      costUsd: 0,
    };
  }

  async isRelevant(_rule: Rule, chunks: RuleChunkRef[]) {
    const relevant = chunks.some((chunk) => controlsForText(chunk.text).length > 0);
    return {
      relevant,
      reason: relevant ? "matches at least one catalogue control" : "no catalogue control matches the text",
      costUsd: 0,
    };
  }

  async extractObligations(_rule: Rule, chunks: RuleChunkRef[]) {
    const obligations = CONTROLS.flatMap((control) => {
      const sources = chunks.filter((chunk) => control.ruleKeywords.test(chunk.text));
      if (sources.length === 0) return [];
      return [
        {
          obligation: control.obligation,
          applies_to: control.appliesTo,
          technical_controls: control.searchTerms,
          source_chunk_ids: sources.map((chunk) => chunk.id),
          controlId: control.id,
        },
      ];
    });
    return { obligations, costUsd: 0 };
  }

  async assess(input: AssessInput) {
    const control: Control | undefined = input.obligation.controlId
      ? controlById(input.obligation.controlId)
      : CONTROLS.find((c) => c.obligation === input.obligation.obligation);
    const citations = input.obligation.sourceChunkIds;

    if (!control) {
      return {
        assessment: {
          status: "needs_review" as const,
          severity: "medium" as const,
          rationale: "The offline baseline has no control mapped to this obligation, so a person needs to assess it.",
          evidence: [],
          citation_chunk_ids: citations,
        },
        costUsd: 0,
      };
    }

    const violations = matchLines(input, control.violationPatterns);
    if (violations.length > 0) {
      return {
        assessment: {
          status: "violation" as const,
          severity: control.severity,
          rationale: `Code matching a known anti-pattern for "${control.id}" was found at the cited lines, which conflicts with the obligation.`,
          evidence: toRanges(violations),
          citation_chunk_ids: citations,
        },
        costUsd: 0,
      };
    }

    const compliant = matchLines(input, control.compliantPatterns);
    if (compliant.length > 0) {
      return {
        assessment: {
          status: "compliant" as const,
          severity: "low" as const,
          rationale: `The cited lines implement the "${control.id}" control and no conflicting code was found.`,
          evidence: toRanges(compliant),
          citation_chunk_ids: citations,
        },
        costUsd: 0,
      };
    }

    const anchors = control.anchorPatterns ? matchLines(input, control.anchorPatterns) : [];
    if (anchors.length > 0) {
      return {
        assessment: {
          status: "violation" as const,
          severity: control.severity,
          rationale: `No implementation of the "${control.id}" control was found anywhere in the repository. The cited location is where it would normally be wired in.`,
          evidence: toRanges(anchors, 2),
          citation_chunk_ids: citations,
        },
        costUsd: 0,
      };
    }

    return {
      assessment: {
        status: "needs_review" as const,
        severity: "medium" as const,
        rationale: `No code related to the "${control.id}" control was found, so the obligation could not be assessed from the repository alone.`,
        evidence: [],
        citation_chunk_ids: citations,
      },
      costUsd: 0,
    };
  }
}
