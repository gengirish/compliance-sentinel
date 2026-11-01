import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { blockText, firstWithText, PAGE_NOISE, slugOf } from "./html.js";
import { fetchWithRetry } from "./http.js";
import { isoDate } from "./rss.js";

/**
 * CISA directives: Binding Operational Directives and Emergency Directives,
 * plus their implementation guidance and supplemental direction. They are
 * compulsory for federal civilian agencies, so they carry more compliance
 * weight than CISA's advisories (whose feed is mostly KEV additions and ICS
 * advisories). There is no directives feed; the active-directives listing is
 * server-rendered, ten per page, newest first, and each directive page holds
 * the directive's full text.
 */
const BASE = "https://www.cisa.gov";
const LISTING = `${BASE}/news-events/directives/all`;

/** Listing pages to walk at most, ten directives each. */
const MAX_PAGES = 5;

export const CISA_SOURCE: SourceDef = {
  name: "cisa",
  kind: "api",
  url: LISTING,
};

export type CisaListingItem = {
  /** e.g. "BOD 26-04: Prioritizing Security Updates Based on Risk" */
  title: string;
  /** "Binding Operational Directive", "Emergency Directive"... */
  type: string;
  url: string;
  date: string | null;
};

export type CisaDirectivePage = { title: string; type: string | null; date: string | null; text: string };

export type CisaOptions = {
  maxItems?: number;
  maxChars?: number;
  listingUrl?: string;
  fetchImpl?: typeof fetch;
};

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Directive teasers of a listing page, and whether a next page exists. */
export function parseCisaListing(html: string): { items: CisaListingItem[]; hasNext: boolean } {
  const $ = cheerio.load(html);
  const items: CisaListingItem[] = [];
  $(".c-view__row article.c-teaser").each((_, el) => {
    const teaser = $(el);
    const link = teaser.find(".c-teaser__title a[href]").first();
    const href = link.attr("href");
    if (!href || !/\/news-events\/directives\//.test(href)) return;
    items.push({
      title: collapse(link.text()),
      type: collapse(teaser.find(".c-teaser__meta").first().text()),
      url: new URL(href, BASE).toString(),
      date: isoDate(teaser.find(".c-teaser__date time").attr("datetime")),
    });
  });
  return { items, hasNext: $(".c-pager a[rel='next']").length > 0 };
}

/** Title, directive type, date and body text of a directive page. */
export function parseCisaDirectivePage(html: string): CisaDirectivePage {
  const $ = cheerio.load(html);
  const title = collapse($("h1").first().text());
  const type = collapse($(".c-page-title__meta").first().text()) || null;
  const date = isoDate($(".c-page-title__date time").attr("datetime"));
  // The tag list, the hero image and the related-directives cards are not directive text.
  $(`${PAGE_NOISE}, .l-page-section--tags, .c-figure, .c-collection, .c-page-title`).remove();
  const root = firstWithText($, [".l-sidebar__main", ".l-page-section--rich-text", "main"]);
  return { title, type, date, text: blockText($, root) };
}

/** Active CISA directives, newest first, with each directive's full text. */
export async function fetchCisaRules(opts: CisaOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxItems = opts.maxItems ?? config.CISA_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.CISA_MAX_CHARS;
  const listingUrl = opts.listingUrl ?? LISTING;

  const items: CisaListingItem[] = [];
  for (let page = 0; page < MAX_PAGES && items.length < maxItems; page++) {
    const url = page === 0 ? listingUrl : `${listingUrl}?page=${page}`;
    const listing = parseCisaListing(await (await fetchWithRetry(fetchImpl, url)).text());
    items.push(...listing.items);
    if (!listing.hasNext || listing.items.length === 0) break;
  }

  const out: ScrapedRule[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (out.length >= maxItems) break;
    // Slugs are stable and distinct per document, e.g. "ed-26-03-..." and its "v1-ed-26-03-...".
    const externalId = slugOf(item.url);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    let text = "";
    let title = item.title;
    try {
      const page = parseCisaDirectivePage(await (await fetchWithRetry(fetchImpl, item.url)).text());
      text = page.text;
      if (page.title) title = page.title;
    } catch (err) {
      // The listing has only a title, too little to stand in for a directive.
      log.warn("cisa directive page unavailable, skipping", { url: item.url, error: String(err) });
      continue;
    }
    if (!text.trim()) continue;
    if (text.length > maxChars) {
      log.warn("cisa directive truncated", { url: item.url, chars: text.length, kept: maxChars });
      text = text.slice(0, maxChars);
    }
    out.push({ externalId, title, effectiveDate: item.date, url: item.url, rawText: text });
  }
  return out;
}
