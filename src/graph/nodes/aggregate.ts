import { eq } from "drizzle-orm";
import { findings as findingsTable } from "../../db/schema.js";
import { log } from "../../log.js";
import type { AuditStateType, GraphDeps } from "../state.js";
import { SEVERITY_RANK, summarize, type Finding, type Status } from "../types.js";

const STATUS_RANK: Record<Status, number> = { violation: 0, needs_review: 1, compliant: 2 };

function dedupeKey(finding: Finding): string {
  // Same rule, same verdict, same primary code location: the same finding reached twice
  // (overlapping chunk windows often yield one duty worded two ways). Keying on the file
  // alone would wrongly merge distinct duties that happen to be broken in one file.
  const primary = finding.evidence[0];
  const location = primary ? `${primary.path}:${primary.start_line}` : `obligation:${finding.obligationId}`;
  return `${finding.ruleId}|${finding.status}|${location}`;
}

/** Merges findings that cite the same code location for the same rule and orders them worst-first. */
export function aggregateFindings(findings: Finding[]): Finding[] {
  const merged = new Map<string, Finding>();
  for (const finding of findings) {
    const key = dedupeKey(finding);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...finding, evidence: [...finding.evidence], verification: [...finding.verification] });
      continue;
    }
    if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[existing.severity]) existing.severity = finding.severity;
    if (!existing.obligation.includes(finding.obligation)) existing.obligation += ` ${finding.obligation}`;
    if (!existing.rationale.includes(finding.rationale)) existing.rationale += ` ${finding.rationale}`;
    for (const item of finding.evidence) {
      const duplicate = existing.evidence.some(
        (e) => e.path === item.path && e.start_line === item.start_line && e.end_line === item.end_line,
      );
      if (!duplicate) existing.evidence.push(item);
    }
    existing.citationChunkIds = [...new Set([...existing.citationChunkIds, ...finding.citationChunkIds])];
    existing.verification.push(...finding.verification);
  }
  return [...merged.values()].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.ruleId - b.ruleId ||
      a.obligationId.localeCompare(b.obligationId),
  );
}

export function aggregateNode(deps: GraphDeps) {
  return async (state: AuditStateType): Promise<Partial<AuditStateType>> => {
    const finalFindings = aggregateFindings(state.findings);
    const summary = summarize(finalFindings);

    // Replace rather than append so a resumed run does not double-insert.
    await deps.db.transaction(async (tx) => {
      await tx.delete(findingsTable).where(eq(findingsTable.runId, state.runId));
      if (finalFindings.length > 0) {
        await tx.insert(findingsTable).values(
          finalFindings.map((f) => ({
            runId: state.runId,
            ruleId: f.ruleId,
            obligation: f.obligation,
            status: f.status,
            severity: f.severity,
            evidence: f.evidence,
            citationChunkIds: f.citationChunkIds,
            rationale: f.rationale,
          })),
        );
      }
    });

    log.info("findings aggregated", { runId: state.runId, ...summary });
    return { finalFindings, summary };
  };
}
