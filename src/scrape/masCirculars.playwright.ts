import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as cheerio from "cheerio";
import { config, resolveFromRoot } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";

const run = promisify(execFile);

const BASE = "https://www.mas.gov.sg";
/** /regulation/circulars redirects here; the list itself is filled in by JavaScript from a search API behind a WAF. */
export const MAS_LISTING_URL = `${BASE}/regulation/regulations-and-guidance?content_type=Circulars`;

export const MAS_SOURCE: SourceDef = {
  name: "mas",
  kind: "playwright",
  url: MAS_LISTING_URL,
};

export type MasListingItem = {
  title: string;
  url: string;
  /** YYYY-MM-DD from the card's published date, or null. */
  date: string | null;
  summary: string;
};

export type MasCircularPage = {
  title: string;
  text: string;
  pdfUrl: string | null;
  refNo: string | null;
};

export type MasOptions = { maxItems?: number; maxChars?: number; headless?: boolean };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number | string) => String(n).padStart(2, "0");

/** "30 September 2026" -> "2026-09-30". */
export function parseMasDate(raw: string | undefined | null): string | null {
  const m = raw?.match(/(\d{1,2}) ([A-Za-z]+) (\d{4})/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase().slice(0, 3));
  return month >= 0 ? `${m[3]}-${pad(month + 1)}-${pad(m[1]!)}` : null;
}

/** Circular cards from the rendered listing page (one per link into /regulation/circulars/). */
export function parseMasListing(html: string): MasListingItem[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const items: MasListingItem[] = [];
  $("a[href*='/regulation/circulars/']").each((_, el) => {
    const a = $(el);
    const href = a.attr("href");
    const title = a.text().replace(/\s+/g, " ").trim();
    if (!href || !title) return;
    const url = new URL(href, BASE).toString();
    if (seen.has(url)) return;
    seen.add(url);
    const card = a.closest("article, li");
    items.push({
      title,
      url,
      date: parseMasDate(card.find("header").text()),
      summary: card.find(".mas-search-card__body").text().replace(/\s+/g, " ").trim(),
    });
  });
  return items;
}

/** The slug of a circular URL, e.g. ".../regulation/circulars/id10_26" -> "id10_26". */
export function masExternalId(url: string): string {
  const pathname = new URL(url).pathname.replace(/\/+$/, "");
  return pathname.slice(pathname.lastIndexOf("/") + 1) || pathname;
}

const BLOCK_TAGS = "p, h1, h2, h3, h4, h5, li, td, th, dt, dd";

/** Title, body text and the first PDF link of a circular page. */
export function parseMasCircularPage(html: string, pageUrl: string): MasCircularPage {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, header, footer, aside, form, .mas-site-nav, .mas-site-footer, .mas-breadcrumbs").remove();
  const root = $("main").first().length ? $("main").first() : $("body");
  const title = root.find("h1").first().text().replace(/\s+/g, " ").trim();

  const pdfHref = root
    .find("a[href*='.pdf']")
    .map((_, el) => $(el).attr("href") ?? "")
    .get()
    .find((href) => href !== "");
  const pdfUrl = pdfHref ? new URL(pdfHref, pageUrl).toString() : null;

  const lines: string[] = [];
  root.find(BLOCK_TAGS).each((_, el) => {
    if ($(el).find(BLOCK_TAGS).length > 0) return;
    const line = $(el).text().replace(/\s+/g, " ").trim();
    if (line) lines.push(line);
  });
  const text = lines.length ? lines.join("\n") : root.text().replace(/\s+/g, " ").trim();
  const refNo = text.match(/\b(?:Circular|Notice)\s+No\.?\s*:?\s*([A-Z]{1,8}[\s-]?[\w/-]*\d[\w/-]*)/i)?.[1]?.trim() ?? null;
  return { title, text, pdfUrl, refNo };
}

/** Text of a PDF via poppler's pdftotext (the `PDFTOTEXT_BIN` binary), through a temp file. */
export async function pdfToText(pdf: Buffer, bin = config.PDFTOTEXT_BIN): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mas-circular-"));
  const file = path.join(dir, "circular.pdf");
  try {
    writeFileSync(file, pdf);
    const { stdout } = await run(bin, ["-nopgbrk", "-enc", "UTF-8", file, "-"], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    return stdout.replace(/[ \t]+\n/g, "\n").trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The latest MAS circulars, each with its page text and the text of its PDF.
 * The listing is rendered by JavaScript and the search API behind it answers
 * direct requests with a maintenance page, hence a real browser.
 */
export async function scrapeMasCirculars(opts: MasOptions = {}): Promise<ScrapedRule[]> {
  const maxItems = opts.maxItems ?? config.MAS_MAX_ITEMS;
  const maxChars = opts.maxChars ?? config.MAS_MAX_CHARS;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const context = await browser.newContext({
    locale: "en-SG",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  });
  const page = await context.newPage();

  const load = async (url: string, label: string, readySelector: string): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForSelector(readySelector, { timeout: 30_000 });
        const html = await page.content();
        if (/<title>\s*Maintenance|service is currently unavailable/i.test(html)) {
          throw new Error("MAS served its maintenance page instead of the content");
        }
        return html;
      } catch (err) {
        lastError = err;
        const dir = resolveFromRoot(path.join(config.REPORTS_DIR, "scrape-failures"));
        mkdirSync(dir, { recursive: true });
        const shot = path.join(dir, `${label}-attempt${attempt}-${Date.now()}.png`);
        await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
        log.warn("mas page load failed", { url, attempt, screenshot: shot, error: String(err) });
        await page.waitForTimeout(2_000 * attempt);
      }
    }
    throw lastError;
  };

  try {
    const listing = parseMasListing(await load(MAS_LISTING_URL, "mas-listing", "a[href*='/regulation/circulars/']"));
    const out: ScrapedRule[] = [];
    for (const item of listing.slice(0, maxItems)) {
      try {
        const circular = parseMasCircularPage(await load(item.url, `mas-${masExternalId(item.url)}`, "h1"), item.url);
        let text = circular.text;
        if (circular.pdfUrl) {
          try {
            // The browser context's request client shares its cookies, so the WAF sees one visitor.
            const res = await context.request.get(circular.pdfUrl, { timeout: 60_000 });
            if (!res.ok()) throw new Error(`HTTP ${res.status()} for ${circular.pdfUrl}`);
            const pdfText = await pdfToText(Buffer.from(await res.body()));
            if (pdfText) text = [text, pdfText].filter(Boolean).join("\n\n");
          } catch (err) {
            log.warn("mas circular pdf unavailable, using the page text", { url: circular.pdfUrl, error: String(err) });
          }
        }
        if (!text.trim()) continue;
        if (text.length > maxChars) {
          log.warn("mas circular truncated", { url: item.url, chars: text.length, kept: maxChars });
          text = text.slice(0, maxChars);
        }
        out.push({
          externalId: circular.refNo ?? masExternalId(item.url),
          title: item.title || circular.title,
          effectiveDate: item.date,
          url: item.url,
          rawText: text,
        });
      } catch (err) {
        log.warn("mas circular skipped", { url: item.url, error: String(err) });
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}
