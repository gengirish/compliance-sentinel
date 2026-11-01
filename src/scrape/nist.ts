import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { fetchWithRetry } from "./http.js";
import { pdfToText } from "./pdf.js";

/**
 * NIST's Computer Security Resource Center has no publications feed (the old
 * CSRC metafeeds are gone) and no public JSON export. Its publication search
 * is server-rendered, filters by status and series in the query string, and
 * sorts newest first, so it serves as the listing. Each publication page has
 * the abstract, keywords and a link to the PDF on nvlpubs.nist.gov, which
 * pdftotext converts.
 */
const BASE = "https://csrc.nist.gov";
const SEARCH = `${BASE}/publications/search`;

/** SP 800 guidance, FIPS standards, and the white papers that carry CSF 2.0 and the Privacy Framework. */
const DEFAULT_SERIES = ["SP", "CSWP", "FIPS"];

/** PDFs larger than this are skipped: the text would be truncated at maxChars anyway. */
const MAX_PDF_BYTES = 40 * 1024 * 1024;

export const NIST_SOURCE: SourceDef = {
  name: "nist",
  kind: "api",
  url: SEARCH,
};

export type NistListingItem = {
  /** "SP", "CSWP", "FIPS"... */
  series: string;
  /** e.g. "800-18 Rev. 2" */
  number: string;
  title: string;
  /** The publication page on csrc.nist.gov. */
  url: string;
  /** YYYY-MM-DD from the release-date column. */
  date: string | null;
  status: string;
};

export type NistPublicationPage = {
  /** e.g. "NIST SP 800-18 Rev. 2" */
  header: string;
  title: string;
  abstract: string;
  keywords: string[];
  supersedes: string[];
  pdfUrl: string | null;
  /** Header, title, date, supersedes, abstract and keywords, one per line. */
  text: string;
};

export type NistOptions = {
  /** Series to search; default SP, CSWP and FIPS. */
  series?: string[];
  /** Keep only SP 800 among the SPs (drops SP 1800 practice guides and SP 13xx quick-start guides). Default true. */
  sp800Only?: boolean;
  maxItems?: number;
  maxChars?: number;
  includePdf?: boolean;
  searchUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injected in tests so they need no pdftotext. */
  pdfToTextImpl?: (pdf: Buffer) => Promise<string>;
};

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Final publications of the given series, newest first. */
export function buildNistSearchUrl(opts: { series?: string[]; perPage?: number; base?: string } = {}): string {
  const url = new URL(opts.base ?? SEARCH);
  url.searchParams.set("sortBy-lg", "releasedate DESC");
  url.searchParams.set("viewMode-lg", "brief");
  url.searchParams.set("ipp-lg", String(opts.perPage ?? 50));
  url.searchParams.set("status-lg", "Final");
  url.searchParams.set("series-lg", (opts.series ?? DEFAULT_SERIES).join(","));
  return url.toString();
}

/** "9/16/2026" -> "2026-09-16". */
export function parseNistDate(raw: string | undefined | null): string | null {
  const m = raw?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : null;
}

/** ("SP", "800-53 Rev. 5") -> "SP 800-53r5", NIST's own short form (as in NIST.SP.800-53r5). */
export function nistExternalId(series: string, number: string): string {
  return `${series} ${number.replace(/\s*Rev\.\s*(\w+)/i, "r$1").replace(/\s+/g, "")}`;
}

/** Rows of the search results table, in page order (newest first). */
export function parseNistSearch(html: string): NistListingItem[] {
  const $ = cheerio.load(html);
  const items: NistListingItem[] = [];
  $("#publications-results-table tbody tr[id^='result-']").each((_, tr) => {
    const n = $(tr).attr("id")!.slice("result-".length);
    const link = $(tr).find(`#pub-title-link-${n}`).first();
    const href = link.attr("href");
    const series = collapse($(tr).find(`#pub-series-${n}`).text());
    const number = collapse($(tr).find(`#pub-number-${n}`).text());
    if (!href || !series || !number) return;
    items.push({
      series,
      number,
      title: collapse(link.text()),
      url: new URL(href, BASE).toString(),
      date: parseNistDate($(tr).find(`#pub-release-date-${n}`).text()),
      status: collapse($(tr).find(`#pub-status-${n}`).text()),
    });
  });
  return items;
}

/** Header, abstract, keywords and the PDF link of a publication page. */
export function parseNistPublicationPage(html: string, pageUrl: string): NistPublicationPage {
  const $ = cheerio.load(html);
  const header = collapse($("#pub-header-full-display").text());
  const title = collapse($("#pub-title").text());
  const released = collapse($("#pub-release-date").text());
  // The abstract is on the page three times (desktop, mobile preview, mobile full); the desktop copy is whole.
  const abstractEl = $("#pub-detail-abstract-info");
  const paragraphs = abstractEl
    .find("p")
    .map((_, p) => collapse($(p).text()))
    .get()
    .filter(Boolean);
  const abstract = paragraphs.length ? paragraphs.join("\n") : collapse(abstractEl.text());
  const keywords = $("[id^='pub-keyword-']")
    .map((_, k) => collapse($(k).text()))
    .get()
    .filter(Boolean);
  const supersedes = $("#pub-supersedes-container a")
    .map((_, a) => collapse($(a).text()))
    .get()
    .filter(Boolean);
  const pdfHref =
    $("#pub-local-download-link").attr("href") ??
    $("a[href$='.pdf']")
      .map((_, el) => $(el).attr("href") ?? "")
      .get()
      .find((href) => /nvlpubs\.nist\.gov/.test(href)) ??
    null;

  const lines = [
    header,
    title,
    released && `Date Published: ${released}`,
    supersedes.length > 0 && `Supersedes: ${supersedes.join("; ")}`,
    abstract && "Abstract",
    abstract,
    keywords.length > 0 && `Keywords: ${keywords.join("; ")}`,
  ].filter((l): l is string => Boolean(l));
  return {
    header,
    title,
    abstract,
    keywords,
    supersedes,
    pdfUrl: pdfHref ? new URL(pdfHref, pageUrl).toString() : null,
    text: lines.join("\n"),
  };
}

/** Recent final NIST publications, with the landing page text and, when enabled, the PDF's text. */
export async function fetchNistRules(opts: NistOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const toText = opts.pdfToTextImpl ?? pdfToText;
  const maxItems = opts.maxItems ?? config.NIST_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.NIST_MAX_CHARS;
  const includePdf = opts.includePdf ?? config.NIST_INCLUDE_PDF;
  const sp800Only = opts.sp800Only ?? true;

  // Ask for more rows than needed: the SP 800 filter drops some of them.
  const searchUrl = buildNistSearchUrl({ series: opts.series, perPage: Math.max(50, maxItems * 4), base: opts.searchUrl });
  const listing = await (await fetchWithRetry(fetchImpl, searchUrl)).text();
  const items = parseNistSearch(listing)
    .filter((item) => /^final$/i.test(item.status) || !item.status)
    .filter((item) => !sp800Only || item.series !== "SP" || /^800-/.test(item.number))
    .slice(0, maxItems);

  const out: ScrapedRule[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const externalId = nistExternalId(item.series, item.number);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    let text: string;
    try {
      const page = parseNistPublicationPage(await (await fetchWithRetry(fetchImpl, item.url)).text(), item.url);
      text = page.text;
      if (includePdf && page.pdfUrl) {
        try {
          const res = await fetchWithRetry(fetchImpl, page.pdfUrl, 3, { timeoutMs: 120_000 });
          const size = Number(res.headers.get("content-length") ?? 0);
          if (size > MAX_PDF_BYTES) throw new Error(`pdf too large (${size} bytes)`);
          const pdfText = await toText(Buffer.from(await res.arrayBuffer()));
          if (pdfText.trim()) text = `${text}\n\n${pdfText}`;
        } catch (err) {
          log.warn("nist publication pdf unavailable, using the page text", { url: page.pdfUrl, error: String(err) });
        }
      }
    } catch (err) {
      // The listing has no summary to stand in, and a title-only rule would read as an amendment later.
      log.warn("nist publication page unavailable, skipping", { url: item.url, error: String(err) });
      continue;
    }
    if (!text.trim()) continue;
    if (text.length > maxChars) {
      log.warn("nist publication truncated", { url: item.url, chars: text.length, kept: maxChars });
      text = text.slice(0, maxChars);
    }
    out.push({
      externalId,
      title: `${item.series} ${item.number}: ${item.title}`,
      effectiveDate: item.date,
      url: item.url,
      rawText: text,
    });
  }
  return out;
}
