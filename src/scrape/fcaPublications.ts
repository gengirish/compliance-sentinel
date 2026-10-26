import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { fetchWithRetry } from "./http.js";

/**
 * The FCA publishes two RSS feeds. /news/rss.xml carries press releases and
 * speeches; policy statements, consultation papers and guidance are in the
 * publications feed, which is the one an audit needs.
 */
const FEED = "https://www.fca.org.uk/publications/rss.xml";

export const FCA_SOURCE: SourceDef = {
  name: "fca",
  kind: "api",
  url: FEED,
};

export type FcaFeedItem = {
  title: string;
  link: string;
  category: string;
  /** YYYY-MM-DD, or null when the feed date could not be read. */
  pubDate: string | null;
  summary: string;
};

export type FcaOptions = {
  types?: string[];
  maxItems?: number;
  maxChars?: number;
  feedUrl?: string;
  fetchImpl?: typeof fetch;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number | string) => String(n).padStart(2, "0");

/** The feed writes dates as "Friday, October 23, 2026 - 11:31"; RFC 822 dates are accepted too. */
export function parseFcaDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = raw.match(/([A-Za-z]+) (\d{1,2}), (\d{4})/);
  if (m) {
    const month = MONTHS.indexOf(m[1]!.toLowerCase().slice(0, 3));
    if (month >= 0) return `${m[3]}-${pad(month + 1)}-${pad(m[2]!)}`;
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** "Policy statements", "policy-statement" and "Policy Statement" compare equal. */
export function normalizeFcaType(type: string): string {
  return type.toLowerCase().replace(/[^a-z]/g, "").replace(/s$/, "");
}

export function parseFcaFeed(xml: string): FcaFeedItem[] {
  // XML mode: in HTML mode <link> is a void element and its text would be lost.
  const $ = cheerio.load(xml, { xml: true });
  const items: FcaFeedItem[] = [];
  $("item").each((_, el) => {
    const item = $(el);
    const link = item.find("link").first().text().trim();
    const title = item.find("title").first().text().replace(/\s+/g, " ").trim();
    if (!link || !title) return;
    items.push({
      title,
      link,
      category: item.find("category").first().text().replace(/\s+/g, " ").trim(),
      pubDate: parseFcaDate(item.find("pubDate").first().text().trim()),
      summary: item.find("description").first().text().replace(/\s+/g, " ").trim(),
    });
  });
  return items;
}

/** The last path segment of a publication URL, e.g. ".../policy-statements/ps21-3-..." -> "ps21-3-...". */
export function fcaExternalId(link: string): string {
  const pathname = new URL(link).pathname.replace(/\/+$/, "");
  return pathname.slice(pathname.lastIndexOf("/") + 1) || pathname;
}

const BLOCK_TAGS = "p, h1, h2, h3, h4, h5, li, td, th, blockquote";
const NOISE =
  "script, style, noscript, nav, header, footer, aside, form, .page-feedback, .related-content, .rhn, " +
  ".breadcrumb, .megamenu, .megamenu-promo, .publication-timeline-slick, .share, .social, .cookie";

/**
 * Readable text of an FCA publication page: the article body (a Drupal
 * node), falling back to the content region and then the whole page.
 */
export function extractFcaPageText(html: string): string {
  const $ = cheerio.load(html);
  $(NOISE).remove();
  const root =
    [".node-content__wrapper", "article.article-header", ".region-content", "body"]
      .map((selector) => $(selector).first())
      .find((el) => el.length > 0 && el.text().trim().length > 0) ?? $("body");

  const lines: string[] = [];
  root.find(BLOCK_TAGS).each((_, el) => {
    // Skip containers whose text is already covered by a nested block element.
    if ($(el).find(BLOCK_TAGS).length > 0) return;
    const line = $(el).text().replace(/\s+/g, " ").trim();
    if (line) lines.push(line);
  });
  return lines.length ? lines.join("\n") : root.text().replace(/\s+/g, " ").trim();
}

/** Recent FCA publications of the configured types, with the text of each publication page. */
export async function fetchFcaRules(opts: FcaOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxItems = opts.maxItems ?? config.FCA_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.FCA_MAX_CHARS;
  const wanted = new Set((opts.types ?? config.FCA_TYPES.split(",")).map(normalizeFcaType).filter(Boolean));

  const xml = await (await fetchWithRetry(fetchImpl, opts.feedUrl ?? FEED)).text();
  const items = parseFcaFeed(xml)
    .filter((item) => wanted.size === 0 || wanted.has(normalizeFcaType(item.category)))
    .slice(0, maxItems);

  const out: ScrapedRule[] = [];
  for (const item of items) {
    let text = item.summary;
    try {
      text = extractFcaPageText(await (await fetchWithRetry(fetchImpl, item.link)).text()) || text;
    } catch (err) {
      log.warn("fca publication page unavailable, using the feed summary", { link: item.link, error: String(err) });
    }
    if (!text.trim()) continue;
    if (text.length > maxChars) {
      log.warn("fca publication truncated", { link: item.link, chars: text.length, kept: maxChars });
      text = text.slice(0, maxChars);
    }
    out.push({
      externalId: fcaExternalId(item.link),
      title: item.title,
      effectiveDate: item.pubDate,
      url: item.link,
      rawText: text,
    });
  }
  return out;
}
