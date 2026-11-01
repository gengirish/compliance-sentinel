import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { blockText, firstWithText, PAGE_NOISE } from "./html.js";
import { fetchWithRetry } from "./http.js";
import { pdfToText } from "./pdf.js";
import { parseRss, type RssItem } from "./rss.js";

/**
 * The Bank of England publishes one RSS feed per area. The prudential
 * regulation one carries PRA consultation papers, policy statements,
 * supervisory statements, statements of policy and Dear CEO letters, along
 * with digests and annual reports that an audit can do without. Recent
 * documents are HTML on the page; older supervisory statements are a short
 * landing page that links the current version as a PDF.
 */
const FEED = "https://www.bankofengland.co.uk/rss/prudential-regulation-publications";

export const PRA_SOURCE: SourceDef = {
  name: "pra",
  kind: "api",
  url: FEED,
};

/** Document kinds kept by default: codes from the title prefix ("CP14/26"), plus Dear CEO/CFO letters. */
export const PRA_DEFAULT_TYPES = ["cp", "ps", "ss", "sop", "dp", "liac", "liaf", "letter"];

export type PraFeedItem = {
  /** e.g. "SS2/26 – High loan to income lending" */
  title: string;
  /** The document code from the title, e.g. "SS2/26", or null. */
  code: string | null;
  /** "cp", "ps", "ss", "sop"... from the code; "letter", "digest" or "publication" otherwise. */
  type: string;
  link: string;
  /** YYYY-MM-DD, or null when the feed date could not be read. */
  date: string | null;
  summary: string;
};

export type PraOptions = {
  /** Document kinds to keep (see PRA_DEFAULT_TYPES). Empty: keep all. */
  types?: string[];
  maxItems?: number;
  maxChars?: number;
  /** Fetch the PDF of documents published only as a PDF (needs pdftotext). Default true. */
  includePdf?: boolean;
  feedUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injected in tests so they need no pdftotext. */
  pdfToTextImpl?: (pdf: Buffer) => Promise<string>;
};

export type PraDocumentPage = {
  title: string;
  text: string;
  /** The "Effective from" date stated on the page, YYYY-MM-DD, or null. */
  effectiveFrom: string | null;
  /** The current version's PDF, set only when the page has no HTML document body. */
  pdfUrl: string | null;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number | string) => String(n).padStart(2, "0");

/**
 * "Wed, 14 Oct 2026 10:00:00 +0100" or "28 October 2026" -> "2026-10-14".
 * The day is read as written: converting to UTC would move items published
 * just after midnight UK time to the previous day.
 */
export function parsePraDate(raw: string | undefined | null): string | null {
  const m = raw?.match(/(\d{1,2}) ([A-Za-z]{3,9}) (\d{4})/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase().slice(0, 3));
  return month >= 0 ? `${m[3]}-${pad(month + 1)}-${pad(m[1]!)}` : null;
}

const CODE = /^(CP|PS|SS|SoP|DP|LIAC|LIAF)\s?\d+\/\d+/i;

export function parsePraItem(item: RssItem): PraFeedItem {
  const code = item.title.match(CODE)?.[0]?.replace(/\s+/g, "") ?? null;
  const path = new URL(item.link).pathname;
  const type = code
    ? code.match(/^[A-Za-z]+/)![0].toLowerCase()
    : /\/letter\//.test(path)
      ? "letter"
      : /\/regulatory-digest\//.test(path)
        ? "digest"
        : "publication";
  return { title: item.title, code, type, link: item.link, date: parsePraDate(item.pubDate), summary: item.description };
}

export function parsePraFeed(xml: string): PraFeedItem[] {
  return parseRss(xml).map(parsePraItem);
}

/**
 * The document code when there is one ("SS9/17" -> "ss9-17"): it survives a
 * page move and makes a reissued statement an amendment of the same rule.
 * Otherwise the path under /prudential-regulation/, since bare slugs repeat
 * across years (e.g. /publication/2013/recovery-planning-ss and /2017/...).
 */
export function praExternalId(item: Pick<PraFeedItem, "code" | "link">): string {
  if (item.code) return item.code.toLowerCase().replace(/\//g, "-");
  const pathname = new URL(item.link).pathname.replace(/\/+$/, "");
  return pathname.replace(/^\/prudential-regulation\//, "").replace(/\//g, "-");
}

/** Page chrome around the document: banner, chapter navigation, footnote pop-ups and related releases. */
const NOISE =
  `${PAGE_NOISE}, .page-banner, .nav-chapters, .modal, .visually-hidden, .pdf-button, ` +
  ".container-latest, .release, .page-section--last";

/** Title, document text, stated effective date and (for PDF-only documents) the current PDF of a PRA page. */
export function parsePraPage(html: string, pageUrl: string): PraDocumentPage {
  const $ = cheerio.load(html);
  const title = $("h1").first().text().replace(/\s+/g, " ").trim();
  let pdfHref: string | null = null;
  if ($(".container-publication").length === 0) {
    // A landing page: the current version is the PDF under the "Current version" heading.
    const current = $("h2")
      .filter((_, h) => /current version/i.test($(h).text()))
      .first()
      .closest(".page-content");
    pdfHref = current.find("a[href$='.pdf']").first().attr("href") ?? null;
  }
  $(NOISE).remove();
  const text = blockText($, firstWithText($, ["#main-content", "main"]));
  const effectiveFrom = parsePraDate(text.match(/Effective from (\d{1,2} [A-Za-z]+ \d{4})/i)?.[1]);
  return { title, text, effectiveFrom, pdfUrl: pdfHref ? new URL(pdfHref, pageUrl).toString() : null };
}

/** Recent PRA documents of the configured kinds, with the document text from each page (or its PDF). */
export async function fetchPraRules(opts: PraOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const toText = opts.pdfToTextImpl ?? pdfToText;
  const maxItems = opts.maxItems ?? config.PRA_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.PRA_MAX_CHARS;
  const includePdf = opts.includePdf ?? true;
  const wanted = new Set((opts.types ?? PRA_DEFAULT_TYPES).map((t) => t.trim().toLowerCase()).filter(Boolean));

  const xml = await (await fetchWithRetry(fetchImpl, opts.feedUrl ?? FEED)).text();
  const items = parsePraFeed(xml)
    .filter((item) => wanted.size === 0 || wanted.has(item.type))
    .slice(0, maxItems);

  const out: ScrapedRule[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const externalId = praExternalId(item);
    if (seen.has(externalId)) continue; // the feed lists some documents twice under different URLs
    seen.add(externalId);
    let text = item.summary;
    let title = item.title;
    let effectiveDate = item.date;
    try {
      const page = parsePraPage(await (await fetchWithRetry(fetchImpl, item.link)).text(), item.link);
      if (page.title) title = page.title;
      if (page.text) text = page.text;
      if (page.effectiveFrom) effectiveDate = page.effectiveFrom;
      if (includePdf && page.pdfUrl) {
        try {
          const pdf = Buffer.from(await (await fetchWithRetry(fetchImpl, page.pdfUrl, 3, { timeoutMs: 120_000 })).arrayBuffer());
          const pdfText = await toText(pdf);
          if (pdfText.trim()) text = `${text}\n\n${pdfText}`;
        } catch (err) {
          log.warn("pra document pdf unavailable, using the page text", { url: page.pdfUrl, error: String(err) });
        }
      }
    } catch (err) {
      log.warn("pra document page unavailable, using the feed summary", { link: item.link, error: String(err) });
    }
    if (!text.trim()) continue;
    if (text.length > maxChars) {
      log.warn("pra document truncated", { link: item.link, chars: text.length, kept: maxChars });
      text = text.slice(0, maxChars);
    }
    out.push({ externalId, title, effectiveDate, url: item.link, rawText: text });
  }
  return out;
}
