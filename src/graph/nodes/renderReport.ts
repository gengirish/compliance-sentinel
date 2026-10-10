import { log } from "../../log.js";
import type { AuditStateType, GraphDeps } from "../state.js";

export function renderReportNode(deps: GraphDeps) {
  return async (state: AuditStateType): Promise<Partial<AuditStateType>> => {
    const report = await deps.renderReport(state);
    log.info("report rendered", { runId: state.runId, path: report.path });
    return { reportUrl: report.url, reportPath: report.path };
  };
}
