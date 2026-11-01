import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { blockText, firstWithText, PAGE_NOISE, slugOf } from "./html.js";
import { fetchWithRetry } from "./http.js";
import { pdfToText } from "./pdf.js";
import { isoDate } from "./rss.js";

/**
 * EBA publications. The site's RSS feeds carry press releases and e-mail
 * alerts only, so this reads the server-rendered publications listing, which
 * filters by document type (one type per request). Each entry links straight
 * to the document's PDF and, usually, to the press release announcing it.
 */
const BASE = "https://www.eba.europa.eu";
const LISTING = `${BASE}/publications-and-media/publications`;

/** The listing's `document_type` filter values. */
export const EBA_DOCUMENT_TYPES = {
  guidelines: 250,
  draftRts: 248,
  draftIts: 247,
  opinions: 252,
  recommendations: 255,
  consultationPapers: 244,
  reports: 257,
} as const;

/** Final rule-making documents: guidelines, draft technical standards and opinions. */
const DEFAULT_TYPES = [
  EBA_DOCUMENT_TYPES.guidelines,
  EBA_DOCUMENT_TYPES.draftRts,
  EBA_DOCUMENT_TYPES.draftIts,
  EBA_DOCUMENT_TYPES.opinions,
];

export const listingUrl = (documentType: number) => `${LISTING}?text=&document_type=${documentType}&media_topics=All`;

export const EBA_SOURCE: SourceDef = {
  name: "eba",
  kind: "api",
  url: LISTING,
};

export type EbaListingItem = {
  /** e.g. "Final Report on Guidelines on the authorisation of third-country branches" */
  title: string;
  /** The document's PDF on www.eba.europa.eu/sites/default/files. */
  url: string;
  /** YYYY-MM-DD from the teaser's calendar line. */
  date: string | null;
  pressReleaseUrl: string | null;
};

export type EbaOptions = {
  /** `document_type` values to list (see EBA_DOCUMENT_TYPES). */
  documentTypes?: number[];
  maxItems?: number;
  maxChars?: number;
  includePdf?: boolean;
  fetchImpl?: typeof fetch;
  /** Injected in tests so they need no pdftotext. */
  pdfToTextImpl?: (pdf: Buffer) => Promise<string>;
};

/** EBA titles and press releases are sprinkled with zero-width spaces. */
const clean = (s: string) => s.replace(/[​﻿]/g, "").replace(/\s+/g, " ").trim();

/** The upload's UUID directory, e.g. ".../2026-07/7e51bdcd-.../Final Report.pdf" -> "7e51bdcd-...". */
export function ebaExternalId(url: string): string {
  return new URL(url).pathname.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i)?.[1] ?? slugOf(url);
}

/**
 * PDF entries of a listing page, in page order (newest first). Annex
 * templates (.xlsx, .docx) and data packages (.zip) are left out.
 */
export function parseEbaListing(html: string): EbaListingItem[] {
  const $ = cheerio.load(html);
  const items: EbaListingItem[] = [];
  $("article.teaser").each((_, el) => {
    const teaser = $(el);
    const link = teaser.find(".teaser__title a[href]").first();
    const href = link.attr("href");
    if (!href) return;
    const url = new URL(href, BASE).toString();
    if (!/\.pdf$/i.test(new URL(url).pathname)) return;
    const press = teaser.find("a[href*='/press-releases/']").first().attr("href");
    items.push({
      title: clean(link.text()),
      url,
      date: isoDate(clean(teaser.find(".link-icon--calendar").first().text()) || null),
      pressReleaseUrl: press ? new URL(press, BASE).toString() : null,
    });
  });
  return items;
}

/** Body of an EBA press release, without the documents box, related content and press contacts. */
export function extractEbaPressReleaseText(html: string): string {
  const $ = cheerio.load(html);
  $(`${PAGE_NOISE}, .breadcrumb-sw, .box-data, .document-download, .page__section__related_content, .box-contacts`).remove();
  const root = firstWithText($, [".node--type-press-release .rich-text", ".node--type-press-release", "main"]);
  return blockText($, root)
    .split("\n")
    .map(clean)
    .filter(Boolean)
    .join("\n");
}

/** Recent EBA publications of the chosen document types, with the press release and the PDF's text. */
export async function fetchEbaRules(opts: EbaOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const toText = opts.pdfToTextImpl ?? pdfToText;
  const maxItems = opts.maxItems ?? config.EBA_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.EBA_MAX_CHARS;
  const includePdf = opts.includePdf ?? true;

  // One listing per type; a document filed under two types (an RTS and ITS package) is kept once.
  const byId = new Map<string, EbaListingItem>();
  for (const documentType of opts.documentTypes ?? DEFAULT_TYPES) {
    const listing = await (await fetchWithRetry(fetchImpl, listingUrl(documentType))).text();
    for (const item of parseEbaListing(listing)) {
      const id = ebaExternalId(item.url);
      if (!byId.has(id)) byId.set(id, item);
    }
  }
  const items = [...byId.entries()]
    .sort(([, a], [, b]) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, maxItems);

  const out: ScrapedRule[] = [];
  for (const [externalId, item] of items) {
    const parts: string[] = [];
    if (item.pressReleaseUrl) {
      try {
        const press = extractEbaPressReleaseText(await (await fetchWithRetry(fetchImpl, item.pressReleaseUrl)).text());
        if (press) parts.push(press);
      } catch (err) {
        log.warn("eba press release unavailable", { url: item.pressReleaseUrl, error: String(err) });
      }
    }
    if (includePdf) {
      try {
        const pdf = Buffer.from(await (await fetchWithRetry(fetchImpl, item.url, 3, { timeoutMs: 120_000 })).arrayBuffer());
        const pdfText = await toText(pdf);
        if (pdfText.trim()) parts.push(pdfText);
      } catch (err) {
        log.warn("eba document pdf unavailable, using the press release", { url: item.url, error: String(err) });
      }
    }
    // With neither, the listing gives nothing but the title.
    let text = parts.join("\n\n") || item.title;
    if (text.length > maxChars) {
      log.warn("eba document truncated", { url: item.url, chars: text.length, kept: maxChars });
      text = text.slice(0, maxChars);
    }
    out.push({ externalId, title: item.title, effectiveDate: item.date, url: item.url, rawText: text });
  }
  return out;
}
