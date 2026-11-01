import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildNistSearchUrl,
  fetchNistRules,
  nistExternalId,
  NIST_SOURCE,
  parseNistDate,
  parseNistPublicationPage,
  parseNistSearch,
} from "../src/scrape/nist.js";

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

const PAGE_URL = "https://csrc.nist.gov/pubs/sp/800/18/r2/final";

describe("NIST CSRC publications", () => {
  it("searches final publications of the chosen series, newest first", () => {
    expect(NIST_SOURCE).toMatchObject({ name: "nist", kind: "api" });
    const url = new URL(buildNistSearchUrl({ series: ["SP", "FIPS"], perPage: 40 }));
    expect(url.origin + url.pathname).toBe("https://csrc.nist.gov/publications/search");
    expect(url.searchParams.get("status-lg")).toBe("Final");
    expect(url.searchParams.get("series-lg")).toBe("SP,FIPS");
    expect(url.searchParams.get("sortBy-lg")).toBe("releasedate DESC");
    expect(url.searchParams.get("ipp-lg")).toBe("40");
  });

  it("reads series, number, title, link and release date from the results table", () => {
    const items = parseNistSearch(fixture("nist-search.html"));
    expect(items.map((i) => `${i.series} ${i.number}`)).toEqual(["CSWP 37B", "SP 800-18 Rev. 2", "CSWP 39upd1"]);
    expect(items[1]).toEqual({
      series: "SP",
      number: "800-18 Rev. 2",
      title: "Developing Security, Privacy, and Cybersecurity Supply Chain Risk Management Plans for Systems",
      url: PAGE_URL,
      date: "2026-06-30",
      status: "Final",
    });
  });

  it("builds NIST's short identifiers and reads US dates", () => {
    expect(nistExternalId("SP", "800-53 Rev. 5")).toBe("SP 800-53r5");
    expect(nistExternalId("SP", "800-172A Rev. 3")).toBe("SP 800-172Ar3");
    expect(nistExternalId("CSWP", "29")).toBe("CSWP 29");
    expect(nistExternalId("FIPS", "140-3")).toBe("FIPS 140-3");
    expect(parseNistDate("9/16/2026")).toBe("2026-09-16");
    expect(parseNistDate("June 2026")).toBeNull();
  });

  it("reads a publication page: abstract once, keywords, supersedes and the PDF", () => {
    const page = parseNistPublicationPage(fixture("nist-page.html"), PAGE_URL);
    expect(page.header).toBe("NIST SP 800-18 Rev. 2");
    expect(page.pdfUrl).toBe("https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-18r2.pdf");
    expect(page.supersedes).toEqual(["SP 800-18 Rev. 1 (02/24/2006)"]);
    expect(page.keywords).toContain("FISMA");
    const lines = page.text.split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "NIST SP 800-18 Rev. 2",
      "Developing Security, Privacy, and Cybersecurity Supply Chain Risk Management Plans for Systems",
      "Date Published: June 2026",
      "Supersedes: SP 800-18 Rev. 1 (02/24/2006)",
    ]);
    // The page repeats the abstract for mobile layouts; it must appear once.
    expect(page.text.match(/collectively referred to as system plans/g)).toHaveLength(1);
    expect(page.text).not.toContain("HEADQUARTERS");
  });

  it("combines the page text with the PDF text, skipping publications whose page is gone", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://csrc.nist.gov/publications/search")) return new Response(fixture("nist-search.html"));
      if (url === PAGE_URL) return new Response(fixture("nist-page.html"));
      if (url.endsWith(".pdf")) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;
    const pdfToTextImpl = vi.fn(async () => "2.1 System Security Plans. Each system shall have a system security plan.");

    const rules = await fetchNistRules({ fetchImpl, pdfToTextImpl, maxItems: 5 });
    expect(rules.map((r) => r.externalId)).toEqual(["SP 800-18r2"]);
    expect(rules[0]).toMatchObject({
      title: "SP 800-18 Rev. 2: Developing Security, Privacy, and Cybersecurity Supply Chain Risk Management Plans for Systems",
      effectiveDate: "2026-06-30",
      url: PAGE_URL,
    });
    expect(rules[0]?.rawText.startsWith("NIST SP 800-18 Rev. 2\n")).toBe(true);
    expect(rules[0]?.rawText.endsWith("Each system shall have a system security plan.")).toBe(true);
    expect(pdfToTextImpl).toHaveBeenCalledTimes(1);

    const noPdf = await fetchNistRules({ fetchImpl, pdfToTextImpl, includePdf: false, maxChars: 50 });
    expect(noPdf[0]?.rawText).toHaveLength(50);
    expect(pdfToTextImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the page text when pdftotext fails", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/publications/search")) return new Response(fixture("nist-search.html"));
      if (url === PAGE_URL) return new Response(fixture("nist-page.html"));
      if (url.endsWith(".pdf")) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;
    const rules = await fetchNistRules({ fetchImpl, pdfToTextImpl: async () => Promise.reject(new Error("no pdftotext")) });
    expect(rules).toHaveLength(1);
    expect(rules[0]?.rawText.split("\n").at(-1)).toMatch(/^Keywords: authorization boundary;/);
  });
});
