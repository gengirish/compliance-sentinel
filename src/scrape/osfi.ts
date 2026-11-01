import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { blockText, firstWithText, PAGE_NOISE, slugOf } from "./html.js";
import { fetchWithRetry } from "./http.js";
import { isoDate } from "./rss.js";

/**
 * OSFI's guidance library: guidelines (B-10, B-13, E-21...), advisories,
 * letters and reporting instructions. The site-wide /en/rss.xml carries news
 * and speeches only, so the library's server-rendered table, newest first, is
 * the listing. Guidance pages hold the full text as HTML, so no PDF step.
 */
const BASE = "https://www.osfi-bsif.gc.ca";
const LIBRARY = `${BASE}/en/guidance/guidance-library`;

export const OSFI_SOURCE: SourceDef = {
  name: "osfi",
  kind: "api",
  url: LIBRARY,
};

export type OsfiLibraryItem = {
  title: string;
  /** The guidance page. */
  url: string;
  /** YYYY-MM-DD from the date column. */
  date: string | null;
  /** e.g. "Guideline", "Letter", "Advisory". */
  publicationType: string;
  category: string | null;
  /** e.g. ["Banks", "Trust and Loan Companies"]. */
  sectors: string[];
};

export type OsfiGuidancePage = {
  title: string;
  /** The guideline number, e.g. "B-10", or null for letters and advisories. */
  number: string | null;
  publicationType: string | null;
  date: string | null;
  text: string;
};

export type OsfiOptions = {
  /** Publication types to keep, e.g. ["Guideline", "Advisory"] (case-insensitive). Empty: keep all. */
  types?: string[];
  maxItems?: number;
  maxChars?: number;
  /** The library page to read, e.g. with `?publication_type=49` (guidelines only). */
  listingUrl?: string;
  fetchImpl?: typeof fetch;
};

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Rows of the guidance library table, in page order (newest first). */
export function parseOsfiLibrary(html: string): OsfiLibraryItem[] {
  const $ = cheerio.load(html);
  const items: OsfiLibraryItem[] = [];
  const seen = new Set<string>();
  $("table tbody tr").each((_, tr) => {
    const row = $(tr);
    const link = row.find(".views-field-title-1 a[href]").first();
    if (link.length === 0) return;
    const url = new URL(link.attr("href")!, BASE).toString();
    if (seen.has(url)) return;
    seen.add(url);
    const time = row.find(".views-field-field-date-1 time").first();
    items.push({
      title: collapse(link.text()),
      url,
      date: isoDate(time.attr("datetime") ?? null) ?? isoDate(collapse(time.text())),
      publicationType: collapse(row.find(".views-field-field-publication-type").text()),
      category: collapse(row.find(".views-field-field-category").text()) || null,
      sectors: row
        .find(".views-field-field-audience-1 li")
        .map((_, li) => collapse($(li).text()))
        .get()
        .filter(Boolean),
    });
  });
  return items;
}

/** Title, guideline number, type, date and body text of a guidance page. */
export function parseOsfiGuidancePage(html: string): OsfiGuidancePage {
  const $ = cheerio.load(html);
  const field = (name: string) => collapse($(`.field--name-field-${name} .field--item`).first().text()) || null;
  const number = collapse($(".paragraph--type--custom-fields .field--label:contains('Number')").next(".field--item").text()) || null;
  const time = $(".field--name-field-date time").first();
  // Footnotes are inline <fn> elements whose text is escaped HTML; keep them as "[n: text]".
  $("fn").each((_, el) => {
    const note = collapse(cheerio.load($(el).text()).text());
    $(el).replaceWith(note ? ` [${$(el).attr("value") ?? "note"}: ${note}]` : "");
  });
  $(`${PAGE_NOISE}, .wb-tabs, .print__wrapper, .pagedetails, #wb-lng`).remove();
  const title = collapse($("h1").first().text());
  const root = firstWithText($, ["article.guidance > .content", "article > .content", "main"]);
  return {
    title,
    number,
    publicationType: field("publication-type"),
    date: isoDate(time.attr("datetime") ?? null),
    text: blockText($, root),
  };
}

/** Recent OSFI guidance of the wanted publication types, with the text of each page. */
export async function fetchOsfiRules(opts: OsfiOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxItems = opts.maxItems ?? config.OSFI_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.OSFI_MAX_CHARS;
  const wanted = new Set((opts.types ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean));

  const listing = await (await fetchWithRetry(fetchImpl, opts.listingUrl ?? LIBRARY)).text();
  const items = parseOsfiLibrary(listing)
    .filter((item) => wanted.size === 0 || wanted.has(item.publicationType.toLowerCase()))
    .slice(0, maxItems);

  const out: ScrapedRule[] = [];
  for (const item of items) {
    let page: OsfiGuidancePage;
    try {
      page = parseOsfiGuidancePage(await (await fetchWithRetry(fetchImpl, item.url)).text());
    } catch (err) {
      // The listing has no summary to stand in for the page.
      log.warn("osfi guidance page unavailable, skipping it", { url: item.url, error: String(err) });
      continue;
    }
    let text = page.text;
    if (!text.trim()) continue;
    if (text.length > maxChars) {
      log.warn("osfi guidance truncated", { url: item.url, chars: text.length, kept: maxChars });
      text = text.slice(0, maxChars);
    }
    const title = page.title || item.title;
    out.push({
      externalId: slugOf(item.url),
      // "B-10 Third-Party Risk Management Guideline"; letters and advisories have no number.
      title: page.number && !title.includes(page.number) ? `${page.number} ${title}` : title,
      effectiveDate: item.date ?? page.date,
      url: item.url,
      rawText: text,
    });
  }
  return out;
}
