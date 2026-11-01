import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CISA_SOURCE, fetchCisaRules, parseCisaDirectivePage, parseCisaListing } from "../src/scrape/cisa.js";

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

const BOD = "https://www.cisa.gov/news-events/directives/bod-26-04-prioritizing-security-updates-based-risk";

describe("CISA directives", () => {
  it("reads the directive teasers of the listing, with type and date", () => {
    expect(CISA_SOURCE).toMatchObject({ name: "cisa", kind: "api", url: "https://www.cisa.gov/news-events/directives/all" });
    const { items, hasNext } = parseCisaListing(fixture("cisa-directives.html"));
    expect(hasNext).toBe(true);
    expect(items.map((i) => i.type)).toEqual(["Binding Operational Directive", "Binding Operational Directive", "Emergency Directive"]);
    expect(items[1]).toEqual({
      title: "BOD 26-04: Prioritizing Security Updates Based on Risk",
      type: "Binding Operational Directive",
      url: BOD,
      date: "2026-06-10",
    });
    expect(items[2]?.date).toBe("2026-04-23");
  });

  it("reads a directive page: title, type, date and the directive text without page chrome", () => {
    const page = parseCisaDirectivePage(fixture("cisa-directive.html"));
    expect(page).toMatchObject({ title: "BOD 26-04: Prioritizing Security Updates Based on Risk", type: "Binding Operational Directives", date: "2026-06-10" });
    const lines = page.text.split("\n");
    expect(lines).toContain("Required Actions");
    expect(lines).toContain("Phase I – Effective immediately, agencies shall:");
    expect(lines).toContain("Asset Exposure: Is the vulnerable asset publicly exposed?");
    expect(page.text).not.toContain("Related Directives");
    expect(page.text).not.toContain("News & Events");
    expect(page.text).not.toContain("Tags");
    expect(page.text).not.toContain("CISA footer.");
  });

  it("keeps each directive once with its page text, skipping directives whose page is gone", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://www.cisa.gov/news-events/directives/all") return new Response(fixture("cisa-directives.html"));
      // The second listing page repeats a directive, which must not be kept twice.
      if (url.endsWith("/directives/all?page=1")) return new Response(fixture("cisa-directives.html").replace(/rel="next"/g, ""));
      if (url === BOD) return new Response(fixture("cisa-directive.html"));
      return new Response("gone", { status: 404 });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const rules = await fetchCisaRules({ fetchImpl, maxItems: 5 });
    expect(rules.map((r) => r.externalId)).toEqual(["bod-26-04-prioritizing-security-updates-based-risk"]);
    expect(rules[0]).toMatchObject({ title: "BOD 26-04: Prioritizing Security Updates Based on Risk", effectiveDate: "2026-06-10", url: BOD });
    expect(rules[0]?.rawText).toContain("A Binding Operational Directive is a compulsory direction");
    const listingCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/directives/all"));
    expect(listingCalls).toHaveLength(2);

    const short = await fetchCisaRules({ fetchImpl, maxItems: 2, maxChars: 40 });
    expect(short).toHaveLength(1);
    expect(short[0]?.rawText).toHaveLength(40);
  });
});
