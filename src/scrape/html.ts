import type { CheerioAPI } from "cheerio";

/** A cheerio selection, as `$()` returns it. */
type Selection = ReturnType<CheerioAPI>;

export const BLOCK_TAGS = "p, h1, h2, h3, h4, h5, h6, li, td, th, dt, dd, blockquote";

/** Elements that never carry regulatory text and only add noise to embeddings. */
export const PAGE_NOISE = "script, style, noscript, nav, header, footer, aside, form, iframe, svg";

/**
 * Readable text of an element: one line per innermost block element, so
 * headings and list items keep their boundaries. Falls back to the element's
 * whole text when it has no block children.
 */
export function blockText($: CheerioAPI, root: Selection): string {
  const lines: string[] = [];
  root.find(BLOCK_TAGS).each((_, el) => {
    // Skip containers whose text is already covered by a nested block element.
    if ($(el).find(BLOCK_TAGS).length > 0) return;
    const line = $(el).text().replace(/\s+/g, " ").trim();
    if (line) lines.push(line);
  });
  return lines.length ? lines.join("\n") : root.text().replace(/\s+/g, " ").trim();
}

/** The first of `selectors` that matches something with text, else the body. */
export function firstWithText($: CheerioAPI, selectors: string[]): Selection {
  for (const selector of selectors) {
    const el = $(selector).first();
    if (el.length > 0 && el.text().trim()) return el;
  }
  return $("body");
}

/** The last path segment of a URL, e.g. ".../notices/26-21" -> "26-21". */
export function slugOf(url: string): string {
  const pathname = new URL(url).pathname.replace(/\/+$/, "");
  return pathname.slice(pathname.lastIndexOf("/") + 1) || pathname;
}
