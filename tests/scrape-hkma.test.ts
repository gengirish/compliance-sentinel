import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fetchHkmaRules, HKMA_FEEDS, HKMA_SOURCE, parseHkmaDate, parseHkmaDocumentPage, parseHkmaFeed } from "../src/scrape/hkma.js";

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

const DOC = "https://brdr.hkma.gov.hk/eng/doc-ldg/current/20261022-1-EN";
const PDF = "https://brdr.hkma.gov.hk/eng/doc-ldg/docId/getPdf/20261022-1-EN/20261022-1-EN.pdf";

describe("HKMA circulars feed", () => {
  it("reads the feed items with the Hong Kong day of pubDate and the sortDate", () => {
    const items = parseHkmaFeed(fixture("hkma-circulars.xml"));
    expect(items).toHaveLength(3);
    expect(items[1]).toEqual({
      title: "Anti-bribery & corruption controls for account opening",
      link: DOC,
      date: "2026-10-22",
      sortDate: "2026-10-22",
    });
    // The CDATA title's trailing space is gone.
    expect(items[2]?.title).toBe("Responsible Adoption of Artificial Intelligence");
    expect(parseHkmaDate("Fri, 23 Oct 2026 00:00:00 +0800")).toBe("2026-10-23");
    expect(parseHkmaDate("5 Mar 1997")).toBe("1997-03-05");
    expect(parseHkmaDate("soon")).toBeNull();
    expect(HKMA_SOURCE).toMatchObject({ name: "hkma", kind: "api", url: HKMA_FEEDS[0] });
  });

  it("reads a BRDR document page: title, type, issue date, topic, group and PDF", () => {
    expect(parseHkmaDocumentPage(fixture("hkma-document.html"), DOC)).toEqual({
      title: "Anti-bribery & corruption controls for account opening",
      docType: "CIR - Circular",
      issueDate: "2026-10-22",
      topics: ["AML & CFT - AML/CFT Controls"],
      group: "All Authorized Institutions",
      pdfUrl: PDF,
    });
  });

  it("fetches the newest documents with the PDF text, falling back to the page and the feed", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/rss_circulars.xml")) return new Response(fixture("hkma-circulars.xml"));
      if (url === DOC) return new Response(fixture("hkma-document.html"));
      if (url === PDF) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;
    const pdfToTextImpl = vi.fn(async () => "The HKMA expects AIs to implement a layered, risk-based approach to account opening.");

    // The guidelines feed 404s; the circulars feed alone still yields rules.
    const rules = await fetchHkmaRules({ fetchImpl, pdfToTextImpl });
    expect(rules.map((r) => r.externalId)).toEqual(["20261022-2-EN", "20261022-1-EN", "20261015-4-EN"]);
    expect(rules[1]).toMatchObject({
      title: "Anti-bribery & corruption controls for account opening",
      effectiveDate: "2026-10-22",
      url: DOC,
    });
    expect(rules[1]?.rawText.split("\n").slice(0, 5)).toEqual([
      "Anti-bribery & corruption controls for account opening",
      "Document type: CIR - Circular",
      "Issue date: 2026-10-22",
      "Topic: AML & CFT - AML/CFT Controls",
      "Group: All Authorized Institutions",
    ]);
    expect(rules[1]?.rawText.endsWith("risk-based approach to account opening.")).toBe(true);
    expect(pdfToTextImpl).toHaveBeenCalledTimes(1);
    // The other pages 404, so the feed title stands in.
    expect(rules[0]?.rawText).toBe("Gazettal of revised SPM module CA-B-2 “Systemically Important Banks”");

    // Without pdftotext, the page metadata stands in for the PDF text.
    const noPdfTool = vi.fn(async () => {
      throw new Error("spawn pdftotext ENOENT");
    });
    const fallback = await fetchHkmaRules({ fetchImpl, pdfToTextImpl: noPdfTool, feedUrl: HKMA_FEEDS[0], maxItems: 2, maxChars: 40 });
    expect(fallback).toHaveLength(2);
    expect(fallback[1]?.rawText).toBe("Anti-bribery & corruption controls for a");
  });

  it("fails when no feed can be read", async () => {
    const fetchImpl = vi.fn(async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchHkmaRules({ fetchImpl })).rejects.toThrow(/HTTP 404/);
  });
});
