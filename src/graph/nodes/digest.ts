import { digestRule, type RuleDigestRecord } from "../../digest/digestRule.js";
import { errorMessage, log } from "../../log.js";
import { getRulesByIds } from "../../rag/retrieve.js";
import type { AuditStateType, GraphDeps } from "../state.js";

/** Routes a run by its mode: the code audit, or the digest that only summarises the rules. */
export function routeMode(state: AuditStateType): "extract_obligations" | "digest_rules" {
  return state.mode === "digest" ? "digest_rules" : "extract_obligations";
}

/**
 * The alternative output mode. For each rule in scope it produces a plain
 * language digest (what changed, effective date, who it applies to, key
 * obligations) instead of obligations to audit. No retrieval, no code.
 */
export function digestRulesNode(deps: GraphDeps) {
  return async (state: AuditStateType): Promise<Partial<AuditStateType>> => {
    const rules = await getRulesByIds(deps.db, state.ruleIds);
    const digests: RuleDigestRecord[] = [];
    const errors: string[] = [];
    let costUsd = 0;
    for (const rule of rules) {
      if (deps.budget.exceeded) {
        errors.push(`rule ${rule.id}: digest skipped, run budget of $${deps.budget.maxUsd} reached`);
        continue;
      }
      try {
        const record = await digestRule(deps.db, deps.analyst, rule);
        deps.budget.add(record.costUsd);
        costUsd += record.costUsd;
        digests.push(record);
      } catch (err) {
        if (err && typeof err === "object" && "costUsd" in err) deps.budget.add(Number(err.costUsd) || 0);
        errors.push(`rule ${rule.id}: digest failed: ${errorMessage(err)}`);
      }
    }
    log.info("rules digested", { rules: rules.length, digests: digests.length, reused: digests.filter((d) => d.reused).length, costUsd });
    return { digests, errors, costUsd };
  };
}
