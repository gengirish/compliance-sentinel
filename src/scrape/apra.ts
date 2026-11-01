import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { blockText, firstWithText, PAGE_NOISE, slugOf } from "./html.js";
import { fetchWithRetry } from "./http.js";
import { pdfToText } from "./pdf.js";

/**
 * APRA's only feed (/rss.xml) carries statistical publications, not policy.
 * Two server-rendered listings do: the cross-industry prudential standards
 * page, one accordion per standard with its practice guide, status and
 * commencement date, and the consultations listing sorted by last update.
 * Standard and guide pages render the instrument's full text inline; their
 * "Download PDF" link (legislation.gov.au or apra.gov.au/system/files) is
 * read with pdftotext only when a page carries no inline text.
 */
const BASE = "https://www.apra.gov.au";
const STANDARDS = `${BASE}/cross-industry/prudential-and-reporting-standards`;
const CONSULTATIONS = `${BASE}/consultations?sort_bef_combine=field_last_official_update_value_DESC`;

/** The information security and operational risk documents come first, then the rest newest first. */
const PRIORITY = ["CPS 234", "CPS 230", "CPG 234", "CPG 230"];

/** Below this many characters a page is a stub and the PDF carries the document. */
const MIN_INLINE_CHARS = 2_000;

export const APRA_SOURCE: SourceDef = {
  name: "apra",
  kind: "api",
  url: STANDARDS,
};

export type ApraListingItem = {
  /** e.g. "CPS 234 Information Security" or a consultation title. */
  title: string;
  /** The APRA standard, practice guide or consultation page. */
  url: string;
  /** "standard", "guide" or "consultation". */
  kind: "standard" | "guide" | "consultation";
  /** YYYY-MM-DD: commencement for standards and guides, last update for consultations. */
  date: string | null;
  /** The listing's status badge, e.g. "In force", "Final not yet in force", "Closed". */
  status: string | null;
  /** The listing's one-paragraph description. */
  description: string;
};

export type ApraDocumentPage = { title: string; text: string; pdfUrl: string | null };

export type ApraOptions = {
  /** Up to this many standards and guides, and as many consultations. */
  maxItems?: number;
  maxChars?: number;
  includePdf?: boolean;
  /** Document codes listed first, e.g. ["CPS 234"]. */
  priority?: string[];
  standardsUrl?: string;
  /** Null skips the consultations listing. */
  consultationsUrl?: string | null;
  fetchImpl?: typeof fetch;
  /** Injected in tests so they need no pdftotext. */
  pdfToTextImpl?: (pdf: Buffer) => Promise<string>;
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "1 July 2019" -> "2019-07-01"; null when unreadable. */
export function parseApraDate(raw: string | undefined | null): string | null {
  const m = raw?.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase());
  return month < 0 ? null : `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Standards and practice guides of a prudential standards page, in page order. */
export function parseApraStandards(html: string): ApraListingItem[] {
  const $ = cheerio.load(html);
  const items: ApraListingItem[] = [];
  const seen = new Set<string>();
  // Each accordion body lists the standard and its guides as <article>s; the
  // accordion header repeats the links as buttons, which carry no status.
  $(".accordion-body article").each((_, el) => {
    const article = $(el);
    const link = article.find(".content-title a[href]").first();
    const href = link.attr("href") ?? "";
    const kind = /\/standards\//.test(href) ? "standard" : /\/practice-guides\//.test(href) ? "guide" : null;
    if (!kind) return;
    const url = new URL(href, BASE).toString();
    if (seen.has(url)) return;
    seen.add(url);
    items.push({
      title: collapse(link.text()),
      url,
      kind,
      date: parseApraDate(article.find(".doc-status-date").first().text()),
      status: collapse(article.find(".doc-status-badge").first().text()) || null,
      description: collapse(article.find(".content-description").text()),
    });
  });
  return items;
}

/** Rows of the consultations listing, in listing order. */
export function parseApraConsultations(html: string): ApraListingItem[] {
  const $ = cheerio.load(html);
  const items: ApraListingItem[] = [];
  $(".views-row .node--type-consultation").each((_, el) => {
    const row = $(el);
    const link = row.find(".search-result__title a[href]").first();
    if (!link.length) return;
    // Drupal stores the date-only field as noon UTC, so the datetime's day is the listed day.
    const datetime = row.find(".search-result__date time").attr("datetime");
    items.push({
      title: collapse(link.text()),
      url: new URL(link.attr("href")!, BASE).toString(),
      kind: "consultation",
      date: datetime?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? parseApraDate(row.find(".search-result__date").text()),
      status: collapse(row.find(".anx-pill__label-first").first().text()) || null,
      description: collapse(row.find(".field--name-field-summary").text()),
    });
  });
  return items;
}

/** Title, body text and the PDF link of an APRA standard, guide or consultation page. */
export function parseApraDocumentPage(html: string, pageUrl: string): ApraDocumentPage {
  const $ = cheerio.load(html);
  const pdfHref = $("#download-pdf").attr("href") ?? null;
  // The hero <h1> sits in a <header>, which PAGE_NOISE removes; read it first.
  const title = collapse($("main h1").first().text()) || collapse($("title").text()).replace(/\s*\|\s*APRA$/, "");
  $(`${PAGE_NOISE}, .anx-tabs, .article-tabs__actions, .anx-mega-menu, .anx-breadcrumb`).remove();
  const root = firstWithText($, [".fragments", ".node__content", "main"]);
  return { title, text: blockText($, root), pdfUrl: pdfHref && pdfHref !== "#" ? new URL(pdfHref, pageUrl).toString() : null };
}

/** Priority codes first in the given order, then newest first; undated items last. */
function byPriorityThenDate(priority: string[]) {
  const rank = (item: ApraListingItem) => {
    const i = priority.findIndex((code) => item.title.toUpperCase().startsWith(`${code.toUpperCase()} `));
    return i < 0 ? priority.length : i;
  };
  return (a: ApraListingItem, b: ApraListingItem) => rank(a) - rank(b) || (b.date ?? "").localeCompare(a.date ?? "");
}

/** Status suffix for the title, left off for the ordinary "In force" and "Current". */
function statusNote(item: ApraListingItem): string | null {
  if (item.kind === "consultation") return item.status ? `consultation, ${item.status.toLowerCase()}` : "consultation";
  return item.status && !/^(in force|current)$/i.test(item.status) ? item.status.toLowerCase() : null;
}

/** APRA's cross-industry prudential standards and guides, and recent consultations, with their full text. */
export async function fetchApraRules(opts: ApraOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const toText = opts.pdfToTextImpl ?? pdfToText;
  const maxItems = opts.maxItems ?? config.APRA_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.APRA_MAX_CHARS;
  const includePdf = opts.includePdf ?? true;
  const consultationsUrl = opts.consultationsUrl === undefined ? CONSULTATIONS : opts.consultationsUrl;

  const standardsHtml = await (await fetchWithRetry(fetchImpl, opts.standardsUrl ?? STANDARDS)).text();
  const items = parseApraStandards(standardsHtml)
    .sort(byPriorityThenDate(opts.priority ?? PRIORITY))
    .slice(0, maxItems);
  if (consultationsUrl) {
    try {
      const html = await (await fetchWithRetry(fetchImpl, consultationsUrl)).text();
      items.push(...parseApraConsultations(html).slice(0, maxItems));
    } catch (err) {
      log.warn("apra consultations listing unavailable, keeping the standards", { url: consultationsUrl, error: String(err) });
    }
  }

  const out: ScrapedRule[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const externalId = slugOf(item.url);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    let text = item.description;
    let title = item.title;
    try {
      const page = parseApraDocumentPage(await (await fetchWithRetry(fetchImpl, item.url)).text(), item.url);
      if (page.title) title = page.title;
      text = [item.description, page.text].filter(Boolean).join("\n\n");
      if (includePdf && page.pdfUrl && page.text.length < MIN_INLINE_CHARS) {
        try {
          const pdf = Buffer.from(await (await fetchWithRetry(fetchImpl, page.pdfUrl, 3, { timeoutMs: 120_000 })).arrayBuffer());
          const pdfText = await toText(pdf);
          if (pdfText.trim()) text = `${text}\n\n${pdfText}`;
        } catch (err) {
          log.warn("apra document pdf unavailable, using the page text", { url: page.pdfUrl, error: String(err) });
        }
      }
    } catch (err) {
      log.warn("apra document page unavailable, using the listing description", { url: item.url, error: String(err) });
    }
    if (!text.trim()) continue;
    if (text.length > maxChars) {
      log.warn("apra document truncated", { url: item.url, chars: text.length, kept: maxChars });
      text = text.slice(0, maxChars);
    }
    const note = statusNote(item);
    out.push({
      externalId,
      title: note ? `${title} (${note})` : title,
      effectiveDate: item.date,
      url: item.url,
      rawText: text,
    });
  }
  return out;
}
