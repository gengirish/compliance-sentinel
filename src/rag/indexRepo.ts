import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, notInArray } from "drizzle-orm";
import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { codeChunks, LOCAL_TENANT_ID } from "../db/schema.js";
import { ensureRepo } from "../db/tenants.js";
import { log } from "../log.js";
import { redactSecrets } from "../redact.js";
import { chunkCode } from "./chunker.js";
import type { Embedder } from "./embed.js";

const run = promisify(execFile);

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", "vendor", "out", ".turbo", ".cache",
  "__pycache__", ".venv", "venv", "target", "tmp", "log", "logs",
  // Translation catalogues: large, numerous and never evidence of a control.
  "i18n", "l10n", "locales", "locale", "translations",
]);
/** Generated or bundled files: indexing them costs embeddings and never yields useful evidence. */
const IGNORED_SUFFIXES = [".min.js", ".min.css", ".map", ".bundle.js", ".d.ts", ".snap"];
const IGNORED_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "composer.lock", "Gemfile.lock"]);
const INDEXED_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".java", ".rb", ".php", ".cs",
  ".sql", ".json", ".yml", ".yaml", ".toml", ".env", ".sh", ".tf",
]);
const MAX_FILE_BYTES = 200_000;

export type RepoFile = { path: string; text: string };

/** Lists indexable source files with POSIX-style paths relative to the repo root. */
export function listRepoFiles(root: string): RepoFile[] {
  const out: RepoFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name) || (entry.name.startsWith(".env") ? ".env" : "");
      if (!INDEXED_EXTENSIONS.has(ext)) continue;
      if (IGNORED_FILES.has(entry.name) || IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      if (statSync(full).size > MAX_FILE_BYTES) continue;
      out.push({ path: path.relative(root, full).split(path.sep).join("/"), text: readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Identifies the audited snapshot. Uses the git commit when the tree is clean,
 * otherwise a hash of the file contents, so cited line numbers always refer to
 * the exact text that was indexed.
 */
export async function repoSnapshotId(root: string, files: RepoFile[]): Promise<string> {
  try {
    const { stdout: top } = await run("git", ["-C", root, "rev-parse", "--show-toplevel"]);
    // Only trust git when `root` is itself the repository root (not a subfolder of another repo).
    if (path.resolve(top.trim()) === path.resolve(root)) {
      const { stdout: status } = await run("git", ["-C", root, "status", "--porcelain"]);
      if (status.trim() === "") {
        const { stdout: sha } = await run("git", ["-C", root, "rev-parse", "HEAD"]);
        return sha.trim();
      }
    }
  } catch {
    // Not a git repository: fall through to the content hash.
  }
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(file.text).update("\0");
  return `content-${hash.digest("hex").slice(0, 40)}`;
}

/** Thrown when a repository is over INDEX_MAX_FILES or INDEX_MAX_BYTES. */
export class RepoTooLargeError extends Error {
  constructor(
    readonly files: number,
    readonly bytes: number,
  ) {
    super(
      `repository too large to index: ${files} files, ${bytes} bytes ` +
        `(caps: INDEX_MAX_FILES=${config.INDEX_MAX_FILES}, INDEX_MAX_BYTES=${config.INDEX_MAX_BYTES})`,
    );
    this.name = "RepoTooLargeError";
  }
}

export function assertIndexable(files: RepoFile[], limits = { maxFiles: config.INDEX_MAX_FILES, maxBytes: config.INDEX_MAX_BYTES }): void {
  const bytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.text), 0);
  if (files.length > limits.maxFiles || bytes > limits.maxBytes) throw new RepoTooLargeError(files.length, bytes);
}

export type IndexResult = { repo: string; repoId: number; commitSha: string; files: number; chunks: number; reindexed: boolean };

export type IndexOptions = {
  /** Display name, e.g. "owner/name"; defaults to the folder name. */
  repoName?: string;
  /** Owner of the repository row; defaults to the local tenant. */
  tenantId?: number;
};

/**
 * Indexes the target repo into `code_chunks`; a no-op when this snapshot is already indexed.
 * Older snapshots are dropped, except the repo's baseline, which PR runs are compared with.
 */
export async function indexRepo(db: Db, embedder: Embedder, root: string, opts: IndexOptions = {}): Promise<IndexResult> {
  const repoName = opts.repoName ?? path.basename(path.resolve(root));
  const repoRow = await ensureRepo(db, opts.tenantId ?? LOCAL_TENANT_ID, repoName);
  const repoId = repoRow.id;
  const files = listRepoFiles(root);
  assertIndexable(files);
  const commitSha = await repoSnapshotId(root, files);
  const result = { repo: repoName, repoId, commitSha, files: files.length };

  const existing = await db
    .select({ id: codeChunks.id })
    .from(codeChunks)
    .where(and(eq(codeChunks.repoId, repoId), eq(codeChunks.commitSha, commitSha)))
    .limit(1);
  if (existing.length > 0) return { ...result, chunks: 0, reindexed: false };

  const drafts = files.flatMap((file) =>
    // Redacted here so credentials never reach the embedder, the database or the analyst.
    chunkCode(redactSecrets(file.text, file.path)).map((chunk) => ({ path: file.path, ...chunk })),
  );
  const vectors = await embedder.embed(
    drafts.map((d) => `${d.path}
${d.text}`),
    "document",
  );
  const keep = [commitSha, ...(repoRow.baselineSha ? [repoRow.baselineSha] : [])];
  await db.transaction(async (tx) => {
    await tx.delete(codeChunks).where(and(eq(codeChunks.repoId, repoId), notInArray(codeChunks.commitSha, keep)));
    for (let i = 0; i < drafts.length; i += 50) {
      await tx.insert(codeChunks).values(
        drafts.slice(i, i + 50).map((d, j) => ({
          repoId,
          commitSha,
          path: d.path,
          startLine: d.startLine,
          endLine: d.endLine,
          text: d.text,
          embedding: vectors[i + j]!,
        })),
      );
    }
  });
  log.info("repo indexed", { repo: repoName, repoId, commitSha, files: files.length, chunks: drafts.length });
  return { ...result, chunks: drafts.length, reindexed: true };
}
