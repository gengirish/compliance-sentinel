import { mkdirSync } from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { config, resolveFromRoot } from "../config.js";
import { log } from "../log.js";
import type { ScrapedRule, SourceDef } from "./diff.js";

const BASE = "https://eur-lex.europa.eu/legal-content/EN";

export const EUR_LEX_SOURCE: SourceDef = {
  name: "eur-lex",
  kind: "playwright",
  url: `${BASE}/ALL/?uri=CELEX:${config.EURLEX_CELEX}`,
};

export type EurLexDocument = { title: string; text: string; effectiveDate: string | null };

const BLOCK_TAGS = "p, h1, h2, h3, h4, li, td, div.eli-title, div.oj-doc-ti";

/** Extracts readable text from a EUR-Lex `TXT/HTML` document page. */
export function parseEurLexDocument(html: string): EurLexDocument {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const title =
    $(".eli-main-title, .oj-doc-ti, .doc-ti").first().text().replace(/\s+/g, " ").trim() ||
    $("title").text().replace(/\s+/g, " ").trim();

  const lines: string[] = [];
  $(BLOCK_TAGS).each((_, el) => {
    // Skip containers whose text is already covered by a nested block element.
    if ($(el).find(BLOCK_TAGS).length > 0) return;
    const line = $(el).text().replace(/\s+/g, " ").trim();
    if (line) lines.push(line);
  });
  const text = lines.length ? lines.join("\n") : $("body").text().replace(/\s+/g, " ").trim();

  const dateMatch = text.match(/shall apply from (\d{1,2} \w+ \d{4})/i);
  return { title, text, effectiveDate: dateMatch?.[1] ?? null };
}

/**
 * Finds CELEX numbers of acts that amend or correct the base act, from the
 * "Relationship between documents" block of the EUR-Lex `ALL` page.
 */
export function parseAmendmentCelexIds(html: string, baseCelex: string): string[] {
  const $ = cheerio.load(html);
  const ids = new Set<string>();
  $("a[href*='CELEX']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const match = decodeURIComponent(href).match(/CELEX[:=]([0-9A-Z()]+)/i);
    if (!match) return;
    const celex = match[1]!.toUpperCase();
    if (celex === baseCelex.toUpperCase()) return;
    const row = $(el).closest("tr, li, dd");
    const context = (row.length ? row.text() : $(el).parent().text()).toLowerCase();
    if (/amended by|corrected by|modified by|completed by/.test(context)) ids.add(celex);
  });
  return [...ids];
}

export type EurLexOptions = { celex?: string; maxAmendments?: number; headless?: boolean };

/**
 * Scrapes the base act plus the acts that amend it. EUR-Lex renders through
 * JavaScript and a WAF challenge, hence a real browser instead of fetch.
 */
export async function scrapeEurLex(opts: EurLexOptions = {}): Promise<ScrapedRule[]> {
  const celex = opts.celex ?? config.EURLEX_CELEX;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const context = await browser.newContext({
    locale: "en-GB",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  });
  const page = await context.newPage();

  const load = async (url: string, label: string): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        // The WAF interstitial replaces itself with the document once solved.
        await page.waitForFunction("document.body && document.body.innerText.length > 500", undefined, {
          timeout: 30_000,
        });
        // Long acts keep streaming in after DOMContentLoaded; wait until the text stops growing.
        let previous = -1;
        let stable = 0;
        for (let i = 0; i < 40 && stable < 3; i++) {
          const length = (await page.evaluate("document.body.innerText.length")) as number;
          stable = length === previous ? stable + 1 : 0;
          previous = length;
          await page.waitForTimeout(750);
        }
        return await page.content();
      } catch (err) {
        lastError = err;
        const dir = resolveFromRoot(path.join(config.REPORTS_DIR, "scrape-failures"));
        mkdirSync(dir, { recursive: true });
        const shot = path.join(dir, `${label}-attempt${attempt}-${Date.now()}.png`);
        await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
        log.warn("eur-lex page load failed", { url, attempt, screenshot: shot, error: String(err) });
        await page.waitForTimeout(1_500 * attempt);
      }
    }
    throw lastError;
  };

  try {
    const out: ScrapedRule[] = [];
    const scrapeDoc = async (id: string) => {
      const url = `${BASE}/TXT/HTML/?uri=CELEX:${id}`;
      const doc = parseEurLexDocument(await load(url, `celex-${id}`));
      if (!doc.text) return;
      if (/requested document does not exist/i.test(`${doc.title} ${doc.text.slice(0, 2_000)}`)) {
        log.warn("eur-lex has no English HTML for this act, skipped", { celex: id });
        return;
      }
      out.push({
        externalId: `CELEX:${id}`,
        title: doc.title || `CELEX ${id}`,
        effectiveDate: doc.effectiveDate,
        url: `${BASE}/TXT/?uri=CELEX:${id}`,
        rawText: doc.text,
      });
    };

    await scrapeDoc(celex);
    const allPage = await load(`${BASE}/ALL/?uri=CELEX:${celex}`, `all-${celex}`);
    const amendments = parseAmendmentCelexIds(allPage, celex).slice(0, opts.maxAmendments ?? 5);
    for (const id of amendments) {
      try {
        await scrapeDoc(id);
      } catch (err) {
        log.warn("eur-lex amendment skipped", { celex: id, error: String(err) });
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}
