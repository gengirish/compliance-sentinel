// Temporary: one live pass of the MAS circulars scraper (browser + pdftotext), no database.
import { scrapeMasCirculars } from "./src/scrape/masCirculars.playwright.js";

const rules = await scrapeMasCirculars({ maxItems: 2 });
console.log(`\n=== MAS: ${rules.length} rules`);
for (const r of rules) {
  console.log(`- ${r.externalId} | ${r.effectiveDate} | ${r.title.slice(0, 90)}`);
  console.log(`  ${r.url}`);
  console.log(`  ${r.rawText.length} chars; starts: ${JSON.stringify(r.rawText.slice(0, 200))}`);
  console.log(`  tail: ${JSON.stringify(r.rawText.slice(-200))}`);
}
