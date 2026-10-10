import { inArray } from "drizzle-orm";
import { ruleChunks, type CodeEvidence } from "../../db/schema.js";
import { loadIndexedFiles, type IndexedFiles } from "../evidence.js";
import type { GraphDeps, ObligationStateType } from "../state.js";
import type { Assessment, Finding, Obligation } from "../types.js";

const MAX_EXCERPT_LINES = 12;

export type VerifyContext = {
  /** rule chunk id -> rule id, for every chunk id the assessment cites that exists. */
  chunkRule: Map<number, number>;
  files: IndexedFiles;
};

/**
 * Deterministic guard against hallucinated citations. Pure so it can be unit
 * tested: every cited chunk must exist and belong to the obligation's rule, and
 * every cited `path:lines` range must exist in the indexed snapshot. Anything
 * else is dropped, and a verdict left without both kinds of support is
 * downgraded to `needs_review`.
 */
export function verifyAssessment(obligation: Obligation, assessment: Assessment, ctx: VerifyContext): Finding {
  const verification: string[] = [];

  const citationChunkIds = [...new Set(assessment.citation_chunk_ids)].filter((id) => {
    const ruleId = ctx.chunkRule.get(id);
    if (ruleId === undefined) {
      verification.push(`Dropped regulation citation ${id}: no such chunk.`);
      return false;
    }
    if (ruleId !== obligation.ruleId) {
      verification.push(`Dropped regulation citation ${id}: it belongs to a different rule.`);
      return false;
    }
    return true;
  });

  const evidence: CodeEvidence[] = [];
  for (const ref of assessment.evidence) {
    const lines = ctx.files.get(ref.path);
    const label = `${ref.path}:${ref.start_line}-${ref.end_line}`;
    if (!lines) {
      verification.push(`Dropped code citation ${label}: file is not in the audited snapshot.`);
      continue;
    }
    if (ref.start_line < 1 || ref.end_line < ref.start_line || ref.end_line > lines.length) {
      verification.push(`Dropped code citation ${label}: lines are outside the file (${lines.length} lines).`);
      continue;
    }
    const excerptEnd = Math.min(ref.end_line, ref.start_line + MAX_EXCERPT_LINES - 1);
    evidence.push({
      path: ref.path,
      start_line: ref.start_line,
      end_line: ref.end_line,
      excerpt: lines.slice(ref.start_line - 1, excerptEnd).join("\n"),
    });
  }

  let { status, severity } = assessment;
  if (status !== "needs_review" && (citationChunkIds.length === 0 || evidence.length === 0)) {
    const missing = [
      citationChunkIds.length === 0 ? "a valid regulation citation" : null,
      evidence.length === 0 ? "a valid code location" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    verification.push(`Downgraded from "${status}" to "needs_review": the verdict lacked ${missing}.`);
    status = "needs_review";
  }
  if (status === "compliant") severity = "low";

  return {
    ruleId: obligation.ruleId,
    obligationId: obligation.id,
    obligation: obligation.obligation,
    status,
    severity,
    rationale: assessment.rationale,
    evidence,
    // Keep the extraction-time sources as a fallback so a review item still points at the rule text.
    citationChunkIds: citationChunkIds.length ? citationChunkIds : status === "needs_review" ? obligation.sourceChunkIds : [],
    verification,
  };
}

export function verifyCitationsNode(deps: GraphDeps) {
  return async (state: ObligationStateType): Promise<Partial<ObligationStateType>> => {
    const { obligation, repo, commitSha } = state.task;
    const assessment = state.assessment;
    if (!assessment) return { errors: [`obligation ${obligation.id}: no assessment to verify`] };

    const cited = [...new Set(assessment.citation_chunk_ids)].filter((id) => Number.isSafeInteger(id));
    const rows = cited.length
      ? await deps.db
          .select({ id: ruleChunks.id, ruleId: ruleChunks.ruleId })
          .from(ruleChunks)
          .where(inArray(ruleChunks.id, cited))
      : [];
    const files = await loadIndexedFiles(deps.db, repo, commitSha);
    const finding = verifyAssessment(obligation, assessment, {
      chunkRule: new Map(rows.map((r) => [r.id, r.ruleId])),
      files,
    });
    return { findings: [finding] };
  };
}
