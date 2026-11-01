import { errorMessage, log } from "../../log.js";
import { AlertDeliveryError } from "../../notify/index.js";
import type { AuditStateType, GraphDeps } from "../state.js";

/** Conditional edge after `render_report`: alert only when a critical violation exists. */
export function severityGate(state: AuditStateType): "notify" | "__end__" {
  return state.summary?.hasCritical ? "notify" : "__end__";
}

export function notifyNode(deps: GraphDeps) {
  return async (state: AuditStateType): Promise<Partial<AuditStateType>> => {
    if (!state.summary) return {};
    try {
      const notified = await deps.notify({
        runId: state.runId,
        summary: state.summary,
        findings: state.finalFindings,
        reportUrl: state.reportUrl,
        reportPath: state.reportPath,
      });
      log.info("alerts sent", { runId: state.runId, channels: notified });
      return { notified };
    } catch (err) {
      // A failed alert must not fail the run: the report and findings are already stored.
      // The failure is recorded in the run's errors, with whichever channels did deliver.
      if (err instanceof AlertDeliveryError) return { notified: err.delivered, errors: [err.message] };
      return { errors: [`notify failed: ${errorMessage(err)}`] };
    }
  };
}
