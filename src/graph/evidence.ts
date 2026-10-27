import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { codeChunks } from "../db/schema.js";
import type { EvidenceSnippet, SearchCoverage } from "./types.js";

/** path -> file lines, rebuilt from the index so evidence always matches the audited snapshot. */
export type IndexedFiles = Map<string, string[]>;

export async function loadIndexedFiles(db: Db, repo: string, commitSha: string): Promise<IndexedFiles> {
  const rows = await db
    .select({
      path: codeChunks.path,
      startLine: codeChunks.startLine,
      text: codeChunks.text,
    })
    .from(codeChunks)
    .where(and(eq(codeChunks.repo, repo), eq(codeChunks.commitSha, commitSha)))
    .orderBy(asc(codeChunks.path), asc(codeChunks.startLine));
  const files: IndexedFiles = new Map();
  for (const row of rows) {
    const lines = files.get(row.path) ?? [];
    row.text.split("\n").forEach((line, i) => {
      lines[row.startLine - 1 + i] = line;
    });
    files.set(row.path, lines);
  }
  // Blank lines trimmed off a chunk edge leave holes; fill them so line numbers stay aligned.
  for (const lines of files.values()) {
    for (let i = 0; i < lines.length; i++) lines[i] ??= "";
  }
  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Window = { path: string; start: number; end: number; terms: Set<string>; hits: number };

/**
 * Case-insensitive keyword search over the indexed files (the grep half of
 * hybrid retrieval). Returns line windows around hits, best-covered first.
 */
const MAX_LISTED_PATHS = 300;

/** Counts, per term, how many indexed files contain it anywhere (case-insensitive). */
export function searchCoverage(files: IndexedFiles, terms: string[]): SearchCoverage {
  const cleaned = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 3))];
  const coverage = cleaned.map((term) => {
    const pattern = new RegExp(escapeRegExp(term), "i");
    let count = 0;
    for (const lines of files.values()) if (lines.some((line) => pattern.test(line))) count++;
    return { term, files: count };
  });
  const paths = [...files.keys()];
  return {
    filesSearched: files.size,
    terms: coverage,
    paths: paths.slice(0, MAX_LISTED_PATHS),
    pathsTruncated: paths.length > MAX_LISTED_PATHS,
  };
}

export function keywordSearch(
  files: IndexedFiles,
  terms: string[],
  opts: { context?: number; maxSnippets?: number; maxHitsPerTerm?: number } = {},
): EvidenceSnippet[] {
  const context = opts.context ?? 2;
  const maxSnippets = opts.maxSnippets ?? 14;
  const maxHitsPerTerm = opts.maxHitsPerTerm ?? 8;
  const cleaned = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 3))];
  const windows: Window[] = [];

  for (const term of cleaned) {
    const pattern = new RegExp(escapeRegExp(term), "i");
    let hits = 0;
    for (const [path, lines] of files) {
      for (let i = 0; i < lines.length && hits < maxHitsPerTerm; i++) {
        if (!pattern.test(lines[i]!)) continue;
        hits++;
        windows.push({
          path,
          start: Math.max(1, i + 1 - context),
          end: Math.min(lines.length, i + 1 + context),
          terms: new Set([term]),
          hits: 1,
        });
      }
    }
  }

  // Merge overlapping or adjacent windows within a file.
  windows.sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start);
  const merged: Window[] = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && last.path === window.path && window.start <= last.end + 1) {
      last.end = Math.max(last.end, window.end);
      window.terms.forEach((t) => last.terms.add(t));
      last.hits += window.hits;
    } else {
      merged.push({ ...window, terms: new Set(window.terms) });
    }
  }

  return merged
    .sort((a, b) => b.terms.size - a.terms.size || b.hits - a.hits || a.path.localeCompare(b.path))
    .slice(0, maxSnippets)
    .map((w) => ({
      path: w.path,
      startLine: w.start,
      endLine: w.end,
      text: files.get(w.path)!.slice(w.start - 1, w.end).join("\n"),
      via: "keyword" as const,
    }));
}

/** Drops snippets fully contained in an earlier snippet of the same file. */
export function dedupeSnippets(snippets: EvidenceSnippet[]): EvidenceSnippet[] {
  const kept: EvidenceSnippet[] = [];
  for (const snippet of snippets) {
    const covered = kept.some(
      (k) => k.path === snippet.path && k.startLine <= snippet.startLine && k.endLine >= snippet.endLine,
    );
    if (!covered) kept.push(snippet);
  }
  return kept;
}
