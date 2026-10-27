import { eq, inArray } from "drizzle-orm";
import { ruleChunks, rules } from "../../db/schema.js";
import { errorMessage } from "../../log.js";
import type { GraphDeps, ObligationStateType } from "../state.js";
import type { Assessment } from "../types.js";

function needsReview(rationale: string, citationChunkIds: number[]): Assessment {
  return { status: "needs_review", severity: "medium", rationale, evidence: [], citation_chunk_ids: citationChunkIds };
}

/** Judges one obligation against its evidence. Failures degrade to `needs_review`, never to a guess. */
export function assessNode(deps: GraphDeps) {
  return async (state: ObligationStateType): Promise<Partial<ObligationStateType>> => {
    const { obligation } = state.task;
    if (deps.budget.exceeded) {
      return {
        assessment: needsReview(
          `Not assessed: the run reached its cost cap of $${deps.budget.maxUsd}.`,
          obligation.sourceChunkIds,
        ),
        errors: [`obligation ${obligation.id}: skipped, run budget reached`],
      };
    }

    const [rule] = await deps.db.select().from(rules).where(eq(rules.id, obligation.ruleId));
    const chunks = await deps.db
      .select({ id: ruleChunks.id, ruleId: ruleChunks.ruleId, sectionRef: ruleChunks.sectionRef, text: ruleChunks.text })
      .from(ruleChunks)
      .where(inArray(ruleChunks.id, obligation.sourceChunkIds));
    if (!rule) {
      return { assessment: needsReview("Not assessed: the rule is no longer in the store.", []) };
    }

    try {
      const { assessment, costUsd } = await deps.analyst.assess({
        rule,
        obligation,
        ruleChunks: chunks,
        evidence: state.evidence,
        coverage: state.coverage,
      });
      deps.budget.add(costUsd);
      return { assessment, costUsd };
    } catch (err) {
      const costUsd = err && typeof err === "object" && "costUsd" in err ? Number(err.costUsd) || 0 : 0;
      deps.budget.add(costUsd);
      return {
        assessment: needsReview(`Not assessed automatically: ${errorMessage(err)}.`, obligation.sourceChunkIds),
        errors: [`obligation ${obligation.id}: assessment failed: ${errorMessage(err)}`],
        costUsd,
      };
    }
  };
}
