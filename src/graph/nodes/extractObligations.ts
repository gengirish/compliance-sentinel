import { errorMessage, log } from "../../log.js";
import { getRuleChunks, getRulesByIds } from "../../rag/retrieve.js";
import type { AuditStateType, GraphDeps } from "../state.js";
import type { Obligation } from "../types.js";

/** Max chunks sent to the model per extraction call; long rules are read in windows. */
const CHUNKS_PER_CALL = 12;

/**
 * For each new rule: skip it if it has no bearing on software, otherwise
 * extract structured obligations. Any chunk id the model returns that was not
 * in the set it was shown is discarded, and an obligation left with no source
 * chunk is rejected.
 */
export function extractObligationsNode(deps: GraphDeps) {
  return async (state: AuditStateType): Promise<Partial<AuditStateType>> => {
    const rules = await getRulesByIds(deps.db, state.ruleIds);
    const obligations: Obligation[] = [];
    const errors: string[] = [];
    let costUsd = 0;
    const spend = (cost: number) => {
      costUsd += cost;
      deps.budget.add(cost);
    };

    for (const rule of rules) {
      const chunks = await getRuleChunks(deps.db, rule.id);
      if (chunks.length === 0) continue;
      if (deps.budget.exceeded) {
        errors.push(`rule ${rule.id}: skipped, run budget of $${deps.budget.maxUsd} reached`);
        continue;
      }
      try {
        const relevance = await deps.analyst.isRelevant(rule, chunks);
        spend(relevance.costUsd);
        if (!relevance.relevant) {
          log.info("rule skipped as not relevant", { ruleId: rule.id, reason: relevance.reason });
          continue;
        }

        let index = 0;
        for (let i = 0; i < chunks.length; i += CHUNKS_PER_CALL) {
          if (deps.budget.exceeded) {
            errors.push(`rule ${rule.id}: extraction stopped early, run budget reached`);
            break;
          }
          const window = chunks.slice(i, i + CHUNKS_PER_CALL);
          const shown = new Set(window.map((c) => c.id));
          const result = await deps.analyst.extractObligations(rule, window);
          spend(result.costUsd);
          for (const draft of result.obligations) {
            const sourceChunkIds = [...new Set(draft.source_chunk_ids)].filter((id) => shown.has(id));
            if (sourceChunkIds.length === 0) {
              errors.push(`rule ${rule.id}: dropped obligation with no valid source chunk: "${draft.obligation.slice(0, 80)}"`);
              continue;
            }
            obligations.push({
              id: `${rule.id}-${index++}`,
              ruleId: rule.id,
              obligation: draft.obligation,
              appliesTo: draft.applies_to,
              technicalControls: draft.technical_controls,
              sourceChunkIds,
              controlId: draft.controlId,
            });
          }
        }
      } catch (err) {
        if (err && typeof err === "object" && "costUsd" in err) spend(Number(err.costUsd) || 0);
        errors.push(`rule ${rule.id}: obligation extraction failed: ${errorMessage(err)}`);
      }
    }

    log.info("obligations extracted", { rules: rules.length, obligations: obligations.length, costUsd });
    return { obligations, errors, costUsd };
  };
}
