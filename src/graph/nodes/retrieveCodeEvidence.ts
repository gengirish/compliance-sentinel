import { retrieveCodeChunks } from "../../rag/retrieve.js";
import { controlById } from "../controls.js";
import { dedupeSnippets, keywordSearch, loadIndexedFiles } from "../evidence.js";
import type { GraphDeps, ObligationStateType } from "../state.js";
import type { EvidenceSnippet } from "../types.js";

const VECTOR_K = 4;

/** Hybrid retrieval: keyword hits for the obligation's technical controls plus vector neighbours. */
export function retrieveCodeEvidenceNode(deps: GraphDeps) {
  return async (state: ObligationStateType): Promise<Partial<ObligationStateType>> => {
    const { obligation, repo, commitSha } = state.task;
    const files = await loadIndexedFiles(deps.db, repo, commitSha);

    const catalogueTerms = obligation.controlId ? (controlById(obligation.controlId)?.searchTerms ?? []) : [];
    const keyword = keywordSearch(files, [...obligation.technicalControls, ...catalogueTerms]);

    const hits = await retrieveCodeChunks(
      deps.db,
      deps.embedder,
      `${obligation.obligation}\n${obligation.technicalControls.join(" ")}`,
      VECTOR_K,
      { repo, commitSha },
    );
    const vector: EvidenceSnippet[] = hits.map((hit) => ({
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      text: hit.text,
      via: "vector" as const,
    }));

    // Vector chunks are wider, so list them first and let them absorb keyword windows they contain.
    return { evidence: dedupeSnippets([...vector, ...keyword]) };
  };
}
