import { END, MemorySaver, Send, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { aggregateNode } from "./nodes/aggregate.js";
import { assessNode } from "./nodes/assess.js";
import { digestRulesNode, routeMode } from "./nodes/digest.js";
import { extractObligationsNode } from "./nodes/extractObligations.js";
import { notifyNode, severityGate } from "./nodes/notify.js";
import { renderReportNode } from "./nodes/renderReport.js";
import { retrieveCodeEvidenceNode } from "./nodes/retrieveCodeEvidence.js";
import { verifyCitationsNode } from "./nodes/verifyCitations.js";
import { AuditState, ObligationState, type AuditStateType, type GraphDeps, type ObligationTask } from "./state.js";

const RETRY = { maxAttempts: 3, initialInterval: 1_000, backoffFactor: 2 };

/** One branch per obligation: retrieve evidence, assess it, verify the citations. */
function buildObligationGraph(deps: GraphDeps) {
  return new StateGraph(ObligationState)
    .addNode("retrieve_code_evidence", retrieveCodeEvidenceNode(deps), { retryPolicy: RETRY })
    .addNode("assess", assessNode(deps), { retryPolicy: RETRY })
    .addNode("verify_citations", verifyCitationsNode(deps), { retryPolicy: RETRY })
    .addEdge(START, "retrieve_code_evidence")
    .addEdge("retrieve_code_evidence", "assess")
    .addEdge("assess", "verify_citations")
    .addEdge("verify_citations", END)
    .compile();
}

/** Fan-out: one `Send` per obligation, or straight to `aggregate` when there are none. */
function fanOut(state: AuditStateType): Send[] | "aggregate" {
  if (state.obligations.length === 0) return "aggregate";
  return state.obligations.map((obligation) => {
    const task: ObligationTask = { obligation, repoId: state.repoId, commitSha: state.commitSha };
    return new Send("assess_obligation", { task });
  });
}

export function buildAuditGraph(deps: GraphDeps, opts: { checkpointer?: BaseCheckpointSaver } = {}) {
  return new StateGraph(AuditState)
    .addNode("extract_obligations", extractObligationsNode(deps), { retryPolicy: RETRY })
    .addNode("digest_rules", digestRulesNode(deps), { retryPolicy: RETRY })
    .addNode("assess_obligation", buildObligationGraph(deps))
    .addNode("aggregate", aggregateNode(deps), { retryPolicy: RETRY })
    .addNode("render_report", renderReportNode(deps), { retryPolicy: RETRY })
    .addNode("notify", notifyNode(deps))
    // mode: the audit path, or the digest that only summarises the rules.
    .addConditionalEdges(START, routeMode, ["extract_obligations", "digest_rules"])
    .addEdge("digest_rules", END)
    .addConditionalEdges("extract_obligations", fanOut, ["assess_obligation", "aggregate"])
    .addEdge("assess_obligation", "aggregate")
    .addEdge("aggregate", "render_report")
    // severity_gate: only a critical violation takes the notify branch.
    .addConditionalEdges("render_report", severityGate, ["notify", END])
    .addEdge("notify", END)
    .compile({
      checkpointer: opts.checkpointer ?? new MemorySaver(),
      // Left in place for an optional human review stage; not wired in v1.
      // interruptBefore: ["render_report"],
    });
}

export type AuditGraph = ReturnType<typeof buildAuditGraph>;

export type AuditInput = Pick<AuditStateType, "runId" | "trigger" | "ruleIds" | "repo" | "repoId" | "commitSha"> & {
  mode?: AuditStateType["mode"];
};

export async function runAuditGraph(
  graph: AuditGraph,
  input: AuditInput,
  opts: { concurrency?: number } = {},
): Promise<AuditStateType> {
  return (await graph.invoke(input, {
    configurable: { thread_id: `audit-run-${input.runId}` },
    maxConcurrency: opts.concurrency ?? 4,
    recursionLimit: 50,
  })) as AuditStateType;
}
