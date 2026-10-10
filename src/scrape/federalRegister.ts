import { z } from "zod";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";

const API = "https://www.federalregister.gov/api/v1/documents.json";

export const FEDERAL_REGISTER_SOURCE: SourceDef = {
  name: "federal-register",
  kind: "api",
  url: API,
};

const DocumentSchema = z.object({
  document_number: z.string(),
  title: z.string(),
  html_url: z.string(),
  raw_text_url: z.string().nullish(),
  abstract: z.string().nullish(),
  effective_on: z.string().nullish(),
  publication_date: z.string().nullish(),
});
const SearchSchema = z.object({ results: z.array(DocumentSchema).default([]) });

export type FederalRegisterOptions = {
  term?: string;
  agencies?: string[];
  perPage?: number;
  maxChars?: number;
  fetchImpl?: typeof fetch;
};

export function buildSearchUrl(opts: { term: string; agencies: string[]; perPage: number }): string {
  const params = new URLSearchParams();
  params.set("per_page", String(opts.perPage));
  params.set("order", "newest");
  params.set("conditions[term]", opts.term);
  params.append("conditions[type][]", "RULE");
  for (const agency of opts.agencies) params.append("conditions[agencies][]", agency);
  for (const field of Object.keys(DocumentSchema.shape)) params.append("fields[]", field);
  return `${API}?${params.toString()}`;
}

async function fetchWithRetry(fetchImpl: typeof fetch, url: string, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { "user-agent": "compliance-sentinel/0.1 (+https://github.com/gengirish/compliance-sentinel)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return res;
      // 4xx other than 429 will not get better on retry.
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status} for ${url}`);
      lastError = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      lastError = err;
      if (err instanceof Error && /^HTTP 4/.test(err.message)) throw err;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
  }
  throw lastError;
}

/** Final rules from the Federal Register's official JSON API, newest first, with full text. */
export async function fetchFederalRegisterRules(opts: FederalRegisterOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxChars = opts.maxChars ?? config.FEDREG_MAX_CHARS;
  const url = buildSearchUrl({
    term: opts.term ?? config.FEDREG_TERM,
    agencies: opts.agencies ?? config.FEDREG_AGENCIES.split(",").map((s) => s.trim()).filter(Boolean),
    perPage: opts.perPage ?? config.FEDREG_PER_PAGE,
  });

  const search = SearchSchema.parse(await (await fetchWithRetry(fetchImpl, url)).json());
  const out: ScrapedRule[] = [];
  for (const doc of search.results) {
    let text = doc.abstract ?? "";
    if (doc.raw_text_url) {
      try {
        text = await (await fetchWithRetry(fetchImpl, doc.raw_text_url)).text();
      } catch (err) {
        log.warn("federal register full text unavailable, using abstract", {
          document: doc.document_number,
          error: String(err),
        });
      }
    }
    if (!text.trim()) continue;
    if (text.length > maxChars) {
      // Some final rules run to hundreds of pages; cap what we embed and say so.
      log.warn("federal register document truncated", {
        document: doc.document_number,
        chars: text.length,
        kept: maxChars,
      });
      text = text.slice(0, maxChars);
    }
    out.push({
      externalId: doc.document_number,
      title: doc.title,
      effectiveDate: doc.effective_on ?? doc.publication_date ?? null,
      url: doc.html_url,
      rawText: text,
    });
  }
  return out;
}
