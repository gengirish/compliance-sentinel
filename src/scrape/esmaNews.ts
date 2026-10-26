import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { blockText, firstWithText, PAGE_NOISE, slugOf } from "./html.js";
import { fetchWithRetry } from "./http.js";
import { isoDate, parseRss, type RssItem } from "./rss.js";

/**
 * ESMA's news (guidelines, technical standards, Q&A updates, statements). The
 * URL /press-news/esma-news/rss answers with an HTML page; the site-wide feed
 * below is the one that carries the news items.
 */
const FEED = "https://www.esma.europa.eu/rss.xml";

export const ESMA_SOURCE: SourceDef = {
  name: "esma",
  kind: "api",
  url: FEED,
};

export type EsmaFeedItem = {
  title: string;
  link: string;
  /** YYYY-MM-DD from the `<time datetime>` in the item, or null. */
  date: string | null;
  /** The news sections the item is filed under, e.g. "Market Abuse". */
  topics: string[];
  summary: string;
};

export type EsmaOptions = {
  /** Keep only items filed under one of these topics (case-insensitive). Empty: keep all. */
  topics?: string[];
  maxItems?: number;
  maxChars?: number;
  feedUrl?: string;
  fetchImpl?: typeof fetch;
};

/** The feed has no pubDate; the date and the topics sit inside the description HTML. */
export function parseEsmaItem(item: RssItem): EsmaFeedItem {
  const $ = cheerio.load(item.descriptionHtml || "");
  const date = isoDate($("time").first().attr("datetime") ?? null) ?? isoDate(item.pubDate);
  const topics = $(".field--name-field-news-section .field__item")
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter(Boolean);
  const intro = $(".field--name-field-news-introduction").text().replace(/\s+/g, " ").trim();
  // Without an introduction field, the rest of the item minus its title, date and topics.
  $(".field--name-field-news-section, .field--name-title, .field--name-created, time").remove();
  const summary = intro || $.root().text().replace(/\s+/g, " ").trim() || item.description;
  return { title: item.title, link: item.link, date, topics, summary };
}

export function parseEsmaFeed(xml: string): EsmaFeedItem[] {
  return parseRss(xml).map(parseEsmaItem);
}

/** Body text of an ESMA news page, without the press-contact block at the end. */
export function extractEsmaPageText(html: string): string {
  const $ = cheerio.load(html);
  $(`${PAGE_NOISE}, .footer-content, .view-content, .field--name-field-news-section`).remove();
  const root = firstWithText($, [".esma-news-page_content", ".node__content", ".region-content"]);
  const text = blockText($, root);
  const contact = text.search(/\n(Further information|Press contact|Media contact)s?:?\s*(\n|$)/i);
  return (contact > 0 ? text.slice(0, contact) : text).trim();
}

/** Recent ESMA news items, with the text of each page. */
export async function fetchEsmaRules(opts: EsmaOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxItems = opts.maxItems ?? config.ESMA_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.ESMA_MAX_CHARS;
  const wanted = new Set((opts.topics ?? config.ESMA_TOPICS.split(",")).map((t) => t.trim().toLowerCase()).filter(Boolean));

  const xml = await (await fetchWithRetry(fetchImpl, opts.feedUrl ?? FEED)).text();
  const items = parseEsmaFeed(xml)
    .filter((item) => wanted.size === 0 || item.topics.some((topic) => wanted.has(topic.toLowerCase())))
    .slice(0, maxItems);

  const out: ScrapedRule[] = [];
  for (const item of items) {
    let text = item.summary;
    try {
      text = extractEsmaPageText(await (await fetchWithRetry(fetchImpl, item.link)).text()) || text;
    } catch (err) {
      log.warn("esma news page unavailable, using the feed summary", { link: item.link, error: String(err) });
    }
    if (!text.trim()) continue;
    if (text.length > maxChars) {
      log.warn("esma news item truncated", { link: item.link, chars: text.length, kept: maxChars });
      text = text.slice(0, maxChars);
    }
    out.push({ externalId: slugOf(item.link), title: item.title, effectiveDate: item.date, url: item.link, rawText: text });
  }
  return out;
}
