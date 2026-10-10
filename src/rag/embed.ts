import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import { config } from "../config.js";
import type { Db } from "../db/client.js";
import { EMBEDDING_DIMENSIONS, embeddingCache } from "../db/schema.js";
import { log } from "../log.js";

export type InputType = "document" | "query";

export interface Embedder {
  readonly model: string;
  embed(texts: string[], inputType: InputType): Promise<number[][]>;
}

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

/** Voyage `voyage-law-2`: legal-tuned, 1024 dimensions. */
export class VoyageEmbedder implements Embedder {
  readonly model: string;
  constructor(
    private readonly apiKey: string,
    model = "voyage-law-2",
    private readonly batchSize = 64,
  ) {
    this.model = model;
  }

  async embed(texts: string[], inputType: InputType): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...(await this.embedBatch(texts.slice(i, i + this.batchSize), inputType)));
    }
    return out;
  }

  private async embedBatch(input: string[], inputType: InputType): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await fetch(VOYAGE_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input, input_type: inputType }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
        return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      }
      lastError = new Error(`Voyage embeddings HTTP ${res.status}: ${await res.text()}`);
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** (attempt - 1)));
    }
    throw lastError;
  }
}

/**
 * Keyless fallback: deterministic feature-hashed bag of words and bigrams.
 * Far weaker than a trained model, but it keeps the pipeline runnable offline
 * and gives tests stable vectors.
 */
export class LocalHashEmbedder implements Embedder {
  readonly model = "local-hash-1024";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => hashEmbed(t));
  }
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or shall that the their this to was were which with".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase so code and prose share tokens
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 ? t.replace(/(?:ing|ed|es|s)$/, "") : t));
}

function bucket(feature: string): { index: number; sign: number } {
  const digest = createHash("md5").update(feature).digest();
  return { index: digest.readUInt32LE(0) % EMBEDDING_DIMENSIONS, sign: digest[4]! & 1 ? 1 : -1 };
}

export function hashEmbed(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const tokens = tokenize(text);
  const add = (feature: string, weight: number) => {
    const { index, sign } = bucket(feature);
    vec[index]! += sign * weight;
  };
  tokens.forEach((token, i) => {
    add(token, 1);
    if (i > 0) add(`${tokens[i - 1]} ${token}`, 0.5);
  });
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  // An all-zero vector has undefined cosine distance; give empty input a fixed direction.
  if (norm === 0) vec[0] = 1;
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

/** Wraps an embedder with a Postgres cache keyed by content hash, so re-runs cost nothing. */
export class CachedEmbedder implements Embedder {
  constructor(
    private readonly inner: Embedder,
    private readonly db: Db,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  private key(text: string, inputType: InputType): string {
    return createHash("sha256").update(`${this.inner.model}\n${inputType}\n${text}`).digest("hex");
  }

  async embed(texts: string[], inputType: InputType): Promise<number[][]> {
    const keys = texts.map((t) => this.key(t, inputType));
    const cached = new Map<string, number[]>();
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += 500) {
      const rows = await this.db
        .select({ hash: embeddingCache.hash, embedding: embeddingCache.embedding })
        .from(embeddingCache)
        .where(inArray(embeddingCache.hash, unique.slice(i, i + 500)));
      for (const row of rows) cached.set(row.hash, row.embedding);
    }

    const missing = new Map<string, string>();
    keys.forEach((key, i) => {
      if (!cached.has(key)) missing.set(key, texts[i]!);
    });
    if (missing.size > 0) {
      const entries = [...missing.entries()];
      const vectors = await this.inner.embed(
        entries.map(([, text]) => text),
        inputType,
      );
      const rows = entries.map(([hash], i) => ({ hash, model: this.inner.model, embedding: vectors[i]! }));
      for (let i = 0; i < rows.length; i += 100) {
        await this.db.insert(embeddingCache).values(rows.slice(i, i + 100)).onConflictDoNothing();
      }
      rows.forEach((row) => cached.set(row.hash, row.embedding));
    }
    return keys.map((key) => cached.get(key)!);
  }
}

export function createEmbedder(db?: Db): Embedder {
  let base: Embedder;
  if (config.VOYAGE_API_KEY) {
    base = new VoyageEmbedder(config.VOYAGE_API_KEY);
  } else {
    log.warn("VOYAGE_API_KEY not set: using the local hash embedder (lower retrieval quality)");
    base = new LocalHashEmbedder();
  }
  return db ? new CachedEmbedder(base, db) : base;
}
