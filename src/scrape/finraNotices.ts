import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { blockText, firstWithText, PAGE_NOISE, slugOf } from "./html.js";
import { fetchWithRetry } from "./http.js";
import { isoDate, parseRss, type RssItem } from "./rss.js";

/** FINRA notices: Regulatory, Information, Election, Special and Trade Reporting Notices share one feed. */
const FEED = "https://www.finra.org/rules-guidance/notices/rss";

export const FINRA_SOURCE: SourceDef = {
  name: "finra",
  kind: "api",
  url: FEED,
};

export type FinraFeedItem = {
  /** e.g. "Regulatory Notice 26-21" */
  title: string;
  /** The notice kind, from the title prefix: "Regulatory Notice", "Election Notice"... */
  type: string;
  link: string;
  date: string | null;
  summary: string;
};

export type FinraOptions = {
  /** Notice kinds to keep, matched against the title prefix (case-insensitive). Empty: keep all. */
  types?: string[];
  maxItems?: number;
  maxChars?: number;
  feedUrl?: string;
  fetchImpl?: typeof fetch;
};

export type FinraNoticePage = { headline: string; noticeType: string | null; text: string; pdfUrl: string | null };

export function parseFinraItem(item: RssItem): FinraFeedItem {
  const type = item.title.match(/^([A-Za-z ]+?Notice)\b/)?.[1]?.trim() ?? "Notice";
  return { title: item.title, type, link: item.link, date: isoDate(item.pubDate), summary: item.description };
}

export function parseFinraFeed(xml: string): FinraFeedItem[] {
  return parseRss(xml).map(parseFinraItem);
}

/** Headline, notice type, body text and PDF link of a notice page. */
export function parseFinraNoticePage(html: string, pageUrl: string): FinraNoticePage {
  const $ = cheerio.load(html);
  $(`${PAGE_NOISE}, .notice-sidebar, .breadcrumb, .menu`).remove();
  const headline = $("h1").first().text().replace(/\s+/g, " ").trim();
  const noticeType =
    $(".field--name-field-notice-type-lst .field__item").first().text().replace(/\s+/g, " ").trim() || null;
  const pdfHref = $("a[href$='.pdf']")
    .map((_, el) => $(el).attr("href") ?? "")
    .get()
    .find((href) => /notice/i.test(href)) ?? null;
  const root = firstWithText($, [".node--type-notices .field--name-body", ".node--type-notices", ".main-content"]);
  return { headline, noticeType, text: blockText($, root), pdfUrl: pdfHref ? new URL(pdfHref, pageUrl).toString() : null };
}

/** Recent FINRA notices of the configured kinds, with the full notice text from each page. */
export async function fetchFinraRules(opts: FinraOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxItems = opts.maxItems ?? config.FINRA_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.FINRA_MAX_CHARS;
  const wanted = new Set((opts.types ?? config.FINRA_TYPES.split(",")).map((t) => t.trim().toLowerCase()).filter(Boolean));

  const xml = await (await fetchWithRetry(fetchImpl, opts.feedUrl ?? FEED)).text();
  const items = parseFinraFeed(xml)
    .filter((item) => wanted.size === 0 || wanted.has(item.type.toLowerCase()))
    .slice(0, maxItems);

  const out: ScrapedRule[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const externalId = slugOf(item.link);
    if (seen.has(externalId)) continue; // the feed repeats some notices
    seen.add(externalId);
    let text = item.summary;
    let title = item.title;
    try {
      const page = parseFinraNoticePage(await (await fetchWithRetry(fetchImpl, item.link)).text(), item.link);
      if (page.text) text = page.text;
      if (page.headline) title = `${item.title}: ${page.headline}`;
    } catch (err) {
      log.warn("finra notice page unavailable, using the feed summary", { link: item.link, error: String(err) });
    }
    if (!text.trim()) continue;
    if (text.length > maxChars) {
      log.warn("finra notice truncated", { link: item.link, chars: text.length, kept: maxChars });
      text = text.slice(0, maxChars);
    }
    out.push({ externalId, title, effectiveDate: item.date, url: item.link, rawText: text });
  }
  return out;
}
