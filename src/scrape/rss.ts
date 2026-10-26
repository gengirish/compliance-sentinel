import * as cheerio from "cheerio";

/** One `<item>` of an RSS 2.0 feed. `description` is the item's HTML reduced to text. */
export type RssItem = {
  title: string;
  link: string;
  description: string;
  descriptionHtml: string;
  /** The raw `<pubDate>` text, or null. */
  pubDate: string | null;
  categories: string[];
  guid: string | null;
};

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Items of an RSS feed, in feed order. Items without a title or link are dropped. */
export function parseRss(xml: string): RssItem[] {
  // XML mode: in HTML mode <link> is a void element and its text would be lost.
  const $ = cheerio.load(xml, { xml: true });
  const items: RssItem[] = [];
  $("item").each((_, el) => {
    const item = $(el);
    const title = collapse(item.find("title").first().text());
    const link = item.find("link").first().text().trim();
    if (!title || !link) return;
    // In XML mode the description's text is its entity-decoded content, i.e. the HTML as a string.
    const descriptionHtml = item.find("description").first().text().trim();
    const description = descriptionHtml ? collapse(cheerio.load(descriptionHtml).text()) : "";
    const pubDate = item.find("pubDate").first().text().trim();
    items.push({
      title,
      link,
      description,
      descriptionHtml,
      pubDate: pubDate || null,
      categories: item
        .find("category")
        .map((_, c) => collapse($(c).text()))
        .get()
        .filter(Boolean),
      guid: item.find("guid").first().text().trim() || null,
    });
  });
  return items;
}

/** "Oct 26, 2026", "2026-10-22T16:51:53+02:00" or an RFC 822 date -> "2026-10-26"; null when unreadable. */
export function isoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const direct = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (direct) return direct[1]!;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  // A date with a time and zone is a moment: take its UTC day. A bare date like
  // "Oct 26, 2026" parses as local midnight, so read it back in local time.
  if (/\d{1,2}:\d{2}/.test(raw)) return d.toISOString().slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
