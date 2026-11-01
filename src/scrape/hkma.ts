import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { slugOf } from "./html.js";
import { fetchWithRetry } from "./http.js";
import { pdfToText } from "./pdf.js";
import { isoDate, parseRss } from "./rss.js";

/**
 * HKMA circulars and guidelines to authorized institutions. The open data API
 * (api.hkma.gov.hk) covers press releases and statistics but not regulatory
 * documents; the RSS feeds below do. Each item links to the Banking Regulatory
 * Document Repository (brdr.hkma.gov.hk), whose page holds the metadata and a
 * link to the PDF that carries the document text.
 */
const RSS = "https://www.hkma.gov.hk/eng/other-information/rss";
export const HKMA_FEEDS = [`${RSS}/rss_circulars.xml`, `${RSS}/rss_guidelines.xml`];

export const HKMA_SOURCE: SourceDef = {
  name: "hkma",
  kind: "api",
  url: HKMA_FEEDS[0]!,
};

export type HkmaFeedItem = {
  title: string;
  /** The BRDR document page, e.g. https://brdr.hkma.gov.hk/eng/doc-ldg/current/20261022-1-EN */
  link: string;
  /** Issue date, YYYY-MM-DD from pubDate, as the Hong Kong day. */
  date: string | null;
  /** The feed's `<sortDate>`: the issue date, or the date an old document was last updated. */
  sortDate: string | null;
};

export type HkmaDocumentPage = {
  title: string;
  /** e.g. "CIR - Circular", "GL - Guideline". */
  docType: string | null;
  issueDate: string | null;
  topics: string[];
  /** Which institutions it addresses, e.g. "All Authorized Institutions". */
  group: string | null;
  pdfUrl: string | null;
};

export type HkmaOptions = {
  maxItems?: number;
  maxChars?: number;
  /** A single feed to read instead of the circulars and guidelines feeds. */
  feedUrl?: string;
  feedUrls?: string[];
  includePdf?: boolean;
  fetchImpl?: typeof fetch;
  /** Injected in tests so they need no pdftotext. */
  pdfToTextImpl?: (pdf: Buffer) => Promise<string>;
};

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Items of an HKMA feed, in feed order. */
export function parseHkmaFeed(xml: string): HkmaFeedItem[] {
  // parseRss does not keep the non-standard <sortDate>, so read it by link.
  const $ = cheerio.load(xml, { xml: true });
  const sortDates = new Map<string, string>();
  $("item").each((_, el) => {
    sortDates.set($(el).find("link").first().text().trim(), $(el).find("sortDate").first().text().trim());
  });
  return parseRss(xml).map((item) => ({
    title: item.title,
    link: item.link,
    // Read the day as written: pubDate is local midnight (+0800), the day before in UTC.
    date: parseHkmaDate(item.pubDate) ?? isoDate(item.pubDate),
    sortDate: isoDate(sortDates.get(item.link)) ?? parseHkmaDate(item.pubDate),
  }));
}

/** "22 Oct 2026" or "Thu, 22 Oct 2026 00:00:00 +0800" -> "2026-10-22". */
export function parseHkmaDate(raw: string | null | undefined): string | null {
  const m = raw?.match(/\b(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})\b/);
  if (!m) return null;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2]!.toLowerCase());
  return month < 0 ? null : `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

/** Title, type, issue date, topics, addressees and PDF link of a BRDR document page. */
export function parseHkmaDocumentPage(html: string, pageUrl: string): HkmaDocumentPage {
  const $ = cheerio.load(html);
  const info = $(".doc-info-container").first();
  const tag = info.find(".tag[title]").first();
  const pdfHref = $(".document-file a[href$='.pdf']").first().attr("href") ?? null;
  // The "Group:" label is followed by a link or a <text> tag, depending on the document.
  const groupRow = $(".details > div").filter((_, el) => /^Group:/.test(collapse($(el).text())));
  return {
    title: collapse(info.find("h1").first().text()),
    docType: tag.attr("title")?.trim() || collapse(tag.text()) || null,
    issueDate: parseHkmaDate(info.find(".issue-date").first().next().text()),
    topics: $(".details a.topic")
      .map((_, el) => collapse($(el).text()))
      .get()
      .filter(Boolean),
    group: collapse(groupRow.find(".tag").first().text()) || null,
    pdfUrl: pdfHref ? new URL(pdfHref, pageUrl).toString() : null,
  };
}

/** The page metadata as a few lines of text, ahead of the PDF text. */
function pageHeader(page: HkmaDocumentPage): string {
  return [
    page.title,
    page.docType && `Document type: ${page.docType}`,
    page.issueDate && `Issue date: ${page.issueDate}`,
    page.topics.length > 0 && `Topic: ${page.topics.join("; ")}`,
    page.group && `Group: ${page.group}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Recent HKMA circulars and guidelines, newest first, with the text of each PDF. */
export async function fetchHkmaRules(opts: HkmaOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const toText = opts.pdfToTextImpl ?? pdfToText;
  const maxItems = opts.maxItems ?? config.HKMA_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.HKMA_MAX_CHARS;
  const includePdf = opts.includePdf ?? config.HKMA_INCLUDE_PDF;
  const feeds = opts.feedUrl ? [opts.feedUrl] : (opts.feedUrls ?? HKMA_FEEDS);

  // A document can sit in both feeds: keep it once. One feed failing does not lose the other.
  const byId = new Map<string, HkmaFeedItem>();
  let lastError: unknown = null;
  for (const feed of feeds) {
    try {
      for (const item of parseHkmaFeed(await (await fetchWithRetry(fetchImpl, feed)).text())) {
        if (!byId.has(slugOf(item.link))) byId.set(slugOf(item.link), item);
      }
    } catch (err) {
      lastError = err;
      log.warn("hkma feed unavailable", { feed, error: String(err) });
    }
  }
  if (byId.size === 0 && lastError) throw lastError;
  const items = [...byId.values()]
    .sort((a, b) => (b.sortDate ?? "").localeCompare(a.sortDate ?? ""))
    .slice(0, maxItems);

  const out: ScrapedRule[] = [];
  for (const item of items) {
    let title = item.title;
    let date = item.date;
    let text = "";
    try {
      const page = parseHkmaDocumentPage(await (await fetchWithRetry(fetchImpl, item.link)).text(), item.link);
      if (page.title) title = page.title;
      date = page.issueDate ?? date;
      text = pageHeader(page);
      if (includePdf && page.pdfUrl) {
        try {
          const pdf = Buffer.from(await (await fetchWithRetry(fetchImpl, page.pdfUrl, 3, { timeoutMs: 120_000 })).arrayBuffer());
          const pdfText = await toText(pdf);
          if (pdfText.trim()) text = `${text}\n\n${pdfText}`;
          // Some documents are scanned images with no text layer; only the metadata is left.
          else log.warn("hkma document pdf has no text, using the page metadata", { url: page.pdfUrl });
        } catch (err) {
          log.warn("hkma document pdf unavailable, using the page metadata", { url: page.pdfUrl, error: String(err) });
        }
      }
    } catch (err) {
      log.warn("hkma document page unavailable, using the feed title", { link: item.link, error: String(err) });
      text = item.title;
    }
    if (!text.trim()) continue;
    if (text.length > maxChars) {
      log.warn("hkma document truncated", { link: item.link, chars: text.length, kept: maxChars });
      text = text.slice(0, maxChars);
    }
    out.push({ externalId: slugOf(item.link), title, effectiveDate: date, url: item.link, rawText: text });
  }
  return out;
}
