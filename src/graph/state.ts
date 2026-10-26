import { Annotation } from "@langchain/langgraph";
import type { RuleDigestRecord } from "../digest/digestRule.js";
import type { Analyst, Budget } from "../llm/analyst.js";
import type { Db } from "../db/client.js";
import type { Embedder } from "../rag/embed.js";
import type { Assessment, EvidenceSnippet, Finding, FindingSummary, Obligation } from "./types.js";

const concat = <T>(left: T[], right: T[] | T): T[] => left.concat(right);
const sum = (left: number, right: number): number => left + right;

/** Top-level state of one audit run. Everything here is JSON-serialisable for the checkpointer. */
export const AuditState = Annotation.Root({
  runId: Annotation<number>,
  trigger: Annotation<"cron" | "manual">,
  /** "audit" maps obligations to code; "digest" only summarises the rules for people. */
  mode: Annotation<"audit" | "digest">({ reducer: (_, next) => next, default: () => "audit" }),
  /** Ids of the new or amended rules in scope. */
  ruleIds: Annotation<number[]>,
  repo: Annotation<string>,
  commitSha: Annotation<string>,
  /** Produced by `digest_rules` in digest mode. */
  digests: Annotation<RuleDigestRecord[]>({ reducer: (_, next) => next, default: () => [] }),
  obligations: Annotation<Obligation[]>({ reducer: (_, next) => next, default: () => [] }),
  /** Raw per-obligation findings, appended by the parallel branches. */
  findings: Annotation<Finding[]>({ reducer: concat, default: () => [] }),
  /** Deduplicated findings produced by `aggregate`. */
  finalFindings: Annotation<Finding[]>({ reducer: (_, next) => next, default: () => [] }),
  summary: Annotation<FindingSummary | null>({ reducer: (_, next) => next, default: () => null }),
  errors: Annotation<string[]>({ reducer: concat, default: () => [] }),
  costUsd: Annotation<number>({ reducer: sum, default: () => 0 }),
  reportUrl: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
  reportPath: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
  notified: Annotation<string[]>({ reducer: concat, default: () => [] }),
});
export type AuditStateType = typeof AuditState.State;

export type ObligationTask = { obligation: Obligation; repo: string; commitSha: string };

/**
 * State of the per-obligation branch (retrieve -> assess -> verify). Only
 * `findings`, `errors` and `costUsd` are shared with the parent graph, so
 * parallel branches never write the same single-value channel.
 */
export const ObligationState = Annotation.Root({
  task: Annotation<ObligationTask>,
  evidence: Annotation<EvidenceSnippet[]>({ reducer: (_, next) => next, default: () => [] }),
  assessment: Annotation<Assessment | null>({ reducer: (_, next) => next, default: () => null }),
  findings: Annotation<Finding[]>({ reducer: concat, default: () => [] }),
  errors: Annotation<string[]>({ reducer: concat, default: () => [] }),
  costUsd: Annotation<number>({ reducer: sum, default: () => 0 }),
});
export type ObligationStateType = typeof ObligationState.State;

export type ReportResult = { url: string; path: string };

export type NotifyInput = {
  runId: number;
  summary: FindingSummary;
  findings: Finding[];
  reportUrl: string | null;
  /** Local path of the rendered report, when it is on disk; email attaches it. */
  reportPath?: string | null;
};

/** Everything the nodes need from the outside world, injected so tests can swap it. */
export type GraphDeps = {
  db: Db;
  embedder: Embedder;
  analyst: Analyst;
  budget: Budget;
  renderReport: (state: AuditStateType) => Promise<ReportResult>;
  notify: (input: NotifyInput) => Promise<string[]>;
};
