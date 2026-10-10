import { and, asc, cosineDistance, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { codeChunks, ruleChunks, rules, type Rule } from "../db/schema.js";
import { chunkRuleText } from "./chunker.js";
import type { Embedder } from "./embed.js";

export type RuleChunkHit = {
  id: number;
  ruleId: number;
  ordinal: number;
  sectionRef: string | null;
  text: string;
  distance: number;
};

export type CodeChunkHit = {
  id: number;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  distance: number;
};

/** Chunks and embeds a rule, replacing any chunks from a previous version of it. */
export async function embedRule(db: Db, embedder: Embedder, rule: Rule): Promise<number> {
  const chunks = chunkRuleText(rule.rawText);
  if (chunks.length === 0) return 0;
  const vectors = await embedder.embed(
    chunks.map((c) => `${rule.title}\n${c.sectionRef ?? ""}\n${c.text}`),
    "document",
  );
  await db.transaction(async (tx) => {
    await tx.delete(ruleChunks).where(eq(ruleChunks.ruleId, rule.id));
    for (let i = 0; i < chunks.length; i += 50) {
      await tx.insert(ruleChunks).values(
        chunks.slice(i, i + 50).map((chunk, j) => ({
          ruleId: rule.id,
          ordinal: chunk.ordinal,
          sectionRef: chunk.sectionRef,
          text: chunk.text,
          embedding: vectors[i + j]!,
          metadata: { model: embedder.model, contentHash: rule.contentHash },
        })),
      );
    }
  });
  return chunks.length;
}

export async function retrieveRuleChunks(
  db: Db,
  embedder: Embedder,
  query: string,
  k = 5,
  opts: { ruleIds?: number[] } = {},
): Promise<RuleChunkHit[]> {
  const [vector] = await embedder.embed([query], "query");
  const distance = cosineDistance(ruleChunks.embedding, vector!);
  return db
    .select({
      id: ruleChunks.id,
      ruleId: ruleChunks.ruleId,
      ordinal: ruleChunks.ordinal,
      sectionRef: ruleChunks.sectionRef,
      text: ruleChunks.text,
      distance: distance.mapWith(Number),
    })
    .from(ruleChunks)
    .where(opts.ruleIds?.length ? inArray(ruleChunks.ruleId, opts.ruleIds) : undefined)
    .orderBy(distance)
    .limit(k);
}

export async function retrieveCodeChunks(
  db: Db,
  embedder: Embedder,
  query: string,
  k = 5,
  opts: { repo: string; commitSha?: string },
): Promise<CodeChunkHit[]> {
  const [vector] = await embedder.embed([query], "query");
  const distance = cosineDistance(codeChunks.embedding, vector!);
  return db
    .select({
      id: codeChunks.id,
      path: codeChunks.path,
      startLine: codeChunks.startLine,
      endLine: codeChunks.endLine,
      text: codeChunks.text,
      distance: distance.mapWith(Number),
    })
    .from(codeChunks)
    .where(
      and(eq(codeChunks.repo, opts.repo), opts.commitSha ? eq(codeChunks.commitSha, opts.commitSha) : undefined),
    )
    .orderBy(distance)
    .limit(k);
}

export async function getRuleChunks(db: Db, ruleId: number) {
  return db
    .select({
      id: ruleChunks.id,
      ruleId: ruleChunks.ruleId,
      ordinal: ruleChunks.ordinal,
      sectionRef: ruleChunks.sectionRef,
      text: ruleChunks.text,
    })
    .from(ruleChunks)
    .where(eq(ruleChunks.ruleId, ruleId))
    .orderBy(asc(ruleChunks.ordinal));
}

export async function getRulesByIds(db: Db, ids: number[]): Promise<Rule[]> {
  if (ids.length === 0) return [];
  return db.select().from(rules).where(inArray(rules.id, ids)).orderBy(asc(rules.id));
}
