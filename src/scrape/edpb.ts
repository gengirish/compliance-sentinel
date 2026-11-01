import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { blockText, firstWithText, PAGE_NOISE, slugOf } from "./html.js";
import { fetchWithRetry } from "./http.js";
import { pdfToText } from "./pdf.js";
import { isoDate, parseRss, type RssItem } from "./rss.js";

/**
 * EDPB publications: guidelines, recommendations, Art. 64/65 opinions,
 * statements and reports. /feed/news_en is mostly national DPA fines; this
 * feed carries the Board's own documents. A document page holds little more
 * than the title, type, date and status; the document itself is the PDF
 * marked as the latest version, which pdftotext converts.
 */
const FEED = "https://www.edpb.europa.eu/feed/publications_en";

export const EDPB_SOURCE: SourceDef = {
  name: "edpb",
  kind: "api",
  url: FEED,
};

export type EdpbFeedItem = {
  /** e.g. "Guidelines 02/2026 on Anonymisation" */
  title: string;
  link: string;
  date: string | null;
  /** The EDPB topics the document is filed under, e.g. "Binding Corporate Rules". */
  topics: string[];
};

export type EdpbDocumentPage = {
  title: string;
  /** "Guideline", "Opinion", "Reports, statements, and letters"... */
  documentType: string | null;
  /** YYYY-MM-DD from the page's `<time datetime>`. */
  date: string | null;
  /** Title, type, date, status and any description, one per line. */
  text: string;
  pdfUrl: string | null;
};

export type EdpbOptions = {
  maxItems?: number;
  maxChars?: number;
  includePdf?: boolean;
  feedUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injected in tests so they need no pdftotext. */
  pdfToTextImpl?: (pdf: Buffer) => Promise<string>;
};

export function parseEdpbItem(item: RssItem): EdpbFeedItem {
  return { title: item.title, link: item.link, date: isoDate(item.pubDate), topics: item.categories };
}

export function parseEdpbFeed(xml: string): EdpbFeedItem[] {
  return parseRss(xml).map(parseEdpbItem);
}

/** Title, type, date, header text and the latest-version PDF of an EDPB document page. */
export function parseEdpbDocumentPage(html: string, pageUrl: string): EdpbDocumentPage {
  const $ = cheerio.load(html);
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  // The latest version first; older versions and "at a glance" summaries follow it.
  const pdfHref =
    $(".document-full__files-item--latest-version a[href$='.pdf']").first().attr("href") ??
    $(".document-full__files a[href$='.pdf']").first().attr("href") ??
    null;
  const title = collapse($("h1.document-full__title, h1").first().text());
  const documentType = collapse($(".document-full__document-type").first().text()) || null;
  const date = isoDate($(".document-full__date time, .document-full__meta time").first().attr("datetime") ?? null);
  $(
    `${PAGE_NOISE}, .breadcrumb, .document-full__files, .document-full__relevant-topics, .document-full__public-consultation, .block-documents-related`,
  ).remove();
  const root = firstWithText($, [".document-full__content", ".document-full", "main"]);
  return { title, documentType, date, text: blockText($, root), pdfUrl: pdfHref ? new URL(pdfHref, pageUrl).toString() : null };
}

/** The EDPB's latest publications, with the page header and the document's PDF text. */
export async function fetchEdpbRules(opts: EdpbOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const toText = opts.pdfToTextImpl ?? pdfToText;
  const maxItems = opts.maxItems ?? config.EDPB_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.EDPB_MAX_CHARS;
  const includePdf = opts.includePdf ?? config.EDPB_INCLUDE_PDF;

  const xml = await (await fetchWithRetry(fetchImpl, opts.feedUrl ?? FEED)).text();
  const items = parseEdpbFeed(xml).slice(0, maxItems);

  const out: ScrapedRule[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const externalId = slugOf(item.link);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    // Without the page, the title and topics are all there is.
    let text = [item.title, ...item.topics].join("\n");
    let title = item.title;
    let date = item.date;
    try {
      const page = parseEdpbDocumentPage(await (await fetchWithRetry(fetchImpl, item.link)).text(), item.link);
      if (page.title) title = page.title;
      if (page.text) text = page.text;
      date ??= page.date;
      if (includePdf && page.pdfUrl) {
        try {
          const pdf = Buffer.from(await (await fetchWithRetry(fetchImpl, page.pdfUrl, 3, { timeoutMs: 120_000 })).arrayBuffer());
          const pdfText = await toText(pdf);
          if (pdfText.trim()) text = `${text}\n\n${pdfText}`;
        } catch (err) {
          log.warn("edpb document pdf unavailable, using the page text", { url: page.pdfUrl, error: String(err) });
        }
      }
    } catch (err) {
      log.warn("edpb document page unavailable, using the feed title", { link: item.link, error: String(err) });
    }
    if (!text.trim()) continue;
    if (text.length > maxChars) {
      log.warn("edpb document truncated", { link: item.link, chars: text.length, kept: maxChars });
      text = text.slice(0, maxChars);
    }
    out.push({ externalId, title, effectiveDate: date, url: item.link, rawText: text });
  }
  return out;
}
