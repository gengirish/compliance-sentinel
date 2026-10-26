import * as cheerio from "cheerio";
import { config } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { blockText, firstWithText, PAGE_NOISE, slugOf } from "./html.js";
import { fetchWithRetry } from "./http.js";
import { pdfToText } from "./pdf.js";

/**
 * ASIC has no feed for regulatory documents, and its document listings are
 * filled in by scripts. The regulatory tracker, a server-rendered table per
 * year of every new and updated regulatory guide, information sheet and
 * report, is the listing that works. Each document page links to the PDF on
 * download.asic.gov.au, which pdftotext converts.
 */
const BASE = "https://www.asic.gov.au";
const TRACKER = `${BASE}/regulatory-resources/find-a-document/regulatory-document-updates/regulatory-tracker`;

export const trackerUrl = (year: number | string) => `${TRACKER}/regulatory-tracker-${year}`;

export const ASIC_SOURCE: SourceDef = {
  name: "asic",
  kind: "api",
  url: TRACKER,
};

export type AsicTrackerItem = {
  /** Link text, e.g. "RG 166 AFS licensing: Financial requirements". */
  title: string;
  /** The ASIC document page. */
  url: string;
  /** YYYY-MM-DD from the release-date column. */
  date: string | null;
  /** The tracker's description of the update. */
  description: string;
  /** A note next to the link, e.g. "reissued" or "new". */
  note: string | null;
};

export type AsicDocumentPage = { title: string; text: string; pdfUrl: string | null };

export type AsicOptions = {
  year?: number | string;
  maxItems?: number;
  maxChars?: number;
  includePdf?: boolean;
  fetchImpl?: typeof fetch;
  /** Injected in tests so they need no pdftotext. */
  pdfToTextImpl?: (pdf: Buffer) => Promise<string>;
};

/** "21/10/2026" -> "2026-10-21". */
export function parseAsicDate(raw: string | undefined | null): string | null {
  const m = raw?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : null;
}

const DOCUMENT_PATH = /\/regulatory-resources\/find-a-document\/(regulatory-guides|information-sheets|reports|consultation-papers)\//;

/** Rows of the tracker table that point at an ASIC document, newest first as the page lists them. */
export function parseAsicTracker(html: string): AsicTrackerItem[] {
  const $ = cheerio.load(html);
  const items: AsicTrackerItem[] = [];
  const seen = new Set<string>();
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 4) return;
    const date = parseAsicDate(cells.eq(0).text());
    if (!date) return; // the header row, or a row without a release date
    const titleCell = cells.eq(2);
    const link = titleCell
      .find("a[href]")
      .toArray()
      .find((a) => DOCUMENT_PATH.test($(a).attr("href") ?? ""));
    if (!link) return;
    const url = new URL($(link).attr("href")!, BASE).toString();
    if (seen.has(url)) return;
    seen.add(url);
    const note = $(link).parent().text().replace($(link).text(), "").match(/\(([^)]+)\)/)?.[1]?.trim() ?? null;
    items.push({
      title: $(link).text().replace(/\s+/g, " ").trim(),
      url,
      date,
      description: cells.eq(3).text().replace(/\s+/g, " ").trim(),
      note,
    });
  });
  return items;
}

/** Title, page text and the PDF link of an ASIC document page. */
export function parseAsicDocumentPage(html: string, pageUrl: string): AsicDocumentPage {
  const $ = cheerio.load(html);
  const pdfHref = $("a[href$='.pdf']")
    .map((_, el) => $(el).attr("href") ?? "")
    .get()
    .find((href) => /download\.asic\.gov\.au/.test(href)) ?? null;
  $(`${PAGE_NOISE}, .asic-sidenav, .asic-breadcrumbs, .asic-mainnav, .asic-footer, .dialog-content`).remove();
  const title = $("h1").first().text().replace(/\s+/g, " ").trim();
  const root = firstWithText($, [".asic-page__article", ".asic-page__main", "main"]);
  return { title, text: blockText($, root), pdfUrl: pdfHref ? new URL(pdfHref, pageUrl).toString() : null };
}

/** The year's new and updated ASIC regulatory documents, with page text and the PDF's text. */
export async function fetchAsicRules(opts: AsicOptions = {}): Promise<ScrapedRule[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const toText = opts.pdfToTextImpl ?? pdfToText;
  const year = opts.year ?? config.ASIC_YEAR ?? new Date().getUTCFullYear();
  const maxItems = opts.maxItems ?? config.ASIC_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.ASIC_MAX_CHARS;
  const includePdf = opts.includePdf ?? config.ASIC_INCLUDE_PDF;

  const listing = await (await fetchWithRetry(fetchImpl, trackerUrl(year))).text();
  const items = parseAsicTracker(listing).slice(0, maxItems);

  const out: ScrapedRule[] = [];
  for (const item of items) {
    let text = item.description;
    let title = item.title;
    try {
      const page = parseAsicDocumentPage(await (await fetchWithRetry(fetchImpl, item.url)).text(), item.url);
      if (page.title) title = page.title;
      text = [item.description, page.text].filter(Boolean).join("\n\n");
      if (includePdf && page.pdfUrl) {
        try {
          const pdf = Buffer.from(await (await fetchWithRetry(fetchImpl, page.pdfUrl, 3, { timeoutMs: 120_000 })).arrayBuffer());
          const pdfText = await toText(pdf);
          if (pdfText.trim()) text = `${text}\n\n${pdfText}`;
        } catch (err) {
          log.warn("asic document pdf unavailable, using the page text", { url: page.pdfUrl, error: String(err) });
        }
      }
    } catch (err) {
      log.warn("asic document page unavailable, using the tracker description", { url: item.url, error: String(err) });
    }
    if (!text.trim()) continue;
    if (text.length > maxChars) {
      log.warn("asic document truncated", { url: item.url, chars: text.length, kept: maxChars });
      text = text.slice(0, maxChars);
    }
    out.push({
      externalId: slugOf(item.url),
      title: item.note ? `${title} (${item.note})` : title,
      effectiveDate: item.date,
      url: item.url,
      rawText: text,
    });
  }
  return out;
}
