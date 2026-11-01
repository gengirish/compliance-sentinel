import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  APRA_SOURCE,
  fetchApraRules,
  parseApraConsultations,
  parseApraDate,
  parseApraDocumentPage,
  parseApraStandards,
} from "../src/scrape/apra.js";

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

/** A guide page with no inline text, only the download link: the PDF carries the document. */
const STUB_PAGE = `<html><head><title>CPG 234 Information Security | APRA</title></head><body><main>
<a href="https://www.apra.gov.au/system/files/cpg_234_information_security_june_2019_0.pdf" id="download-pdf">Download PDF</a>
<div class="fragments"><div class="para">See the PDF.</div></div></main></body></html>`;

describe("APRA prudential standards", () => {
  it("is an api source named apra", () => {
    expect(APRA_SOURCE).toMatchObject({ name: "apra", kind: "api" });
  });

  it("reads the standards and practice guides with status and commencement date", () => {
    const items = parseApraStandards(fixture("apra-standards.html"));
    expect(items.map((i) => i.url.replace("https://www.apra.gov.au", ""))).toEqual([
      "/standards/cps-230",
      "/practice-guides/cpg-230",
      "/standards/cps-234",
      "/practice-guides/cpg-234",
      "/practice-guides/cpg-110",
      "/practice-guides/cpg-110-final-not-force",
    ]);
    expect(items[2]).toEqual({
      title: "CPS 234 Information Security",
      url: "https://www.apra.gov.au/standards/cps-234",
      kind: "standard",
      date: "2019-07-01",
      status: "In force",
      description: "CPS 234 Information Security requires entities to maintain information security capability.",
    });
    expect(items[5]).toMatchObject({ kind: "guide", status: "Final not yet in force", date: "2027-01-01" });
    expect(parseApraDate("1 July 2019")).toBe("2019-07-01");
    expect(parseApraDate("26 November 2021")).toBe("2021-11-26");
    expect(parseApraDate("soon")).toBeNull();
  });

  it("reads the consultations listing with last update and open/closed status", () => {
    const items = parseApraConsultations(fixture("apra-consultations.html"));
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      title: "Transition of Superannuation D2A data collections to APRA Connect",
      kind: "consultation",
      date: "2026-10-27",
      status: "Closed 21 August 2026",
    });
    expect(items[1]).toMatchObject({
      url: "https://www.apra.gov.au/consultations/superannuation-data-transformation-phase-2-depth",
      date: "2026-10-23",
      status: "Open until 6 November 2026",
      description: "APRA undertook a multi-year project to upgrade the breadth, depth and quality of its superannuation data collection.",
    });
  });

  it("reads a standard page: title, inline instrument text including div paragraphs, and the PDF link", () => {
    const page = parseApraDocumentPage(fixture("apra-standard-page.html"), "https://www.apra.gov.au/standards/cps-234");
    expect(page.title).toBe("CPS 234 Information Security");
    expect(page.pdfUrl).toBe("https://www.legislation.gov.au/F2018L01745/asmade/2018-12-12/text/original/pdf");
    const lines = page.text.split("\n");
    expect(lines[0]).toBe("About this standard");
    // A <div class="para"> paragraph, and the lead-in before a nested list.
    expect(lines).toContain("The Board of an APRA-regulated entity is ultimately responsible for ensuring that the entity maintains its information security.");
    expect(lines).toContain("The key requirements of this Prudential Standard are that an APRA-regulated entity must:");
    expect(lines).toContain("notify APRA of material information security incidents.");
    expect(page.text).toContain("confidentiality, integrity or availability");
    // Tabs, related resources and the site chrome are dropped.
    expect(page.text).not.toContain("Related standards, guidance and resources");
    expect(page.text).not.toContain("Download PDF");
    expect(page.text).not.toContain("Copyright APRA");
  });

  it("combines listing descriptions, page text and, for stub pages, the PDF text", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/prudential-and-reporting-standards")) return new Response(fixture("apra-standards.html"));
      if (url.includes("/consultations?")) return new Response(fixture("apra-consultations.html"));
      if (url.endsWith("/standards/cps-234")) return new Response(fixture("apra-standard-page.html"));
      if (url.endsWith("/practice-guides/cpg-234")) return new Response(STUB_PAGE);
      if (url.endsWith(".pdf")) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;
    const pdfToTextImpl = vi.fn(async () => "1. An APRA-regulated entity should maintain an information security policy framework.");

    const rules = await fetchApraRules({ fetchImpl, pdfToTextImpl, maxItems: 3 });
    // CPS 234, CPS 230 and CPG 234 rank first; then the first three consultations, less the
    // D2A one, whose page 404s and whose listing row has no summary to stand in.
    expect(rules.map((r) => r.externalId)).toEqual([
      "cps-234",
      "cps-230",
      "cpg-234",
      "superannuation-data-transformation-phase-2-depth",
      "strengthening-superannuation-investment-governance",
    ]);
    expect(rules[0]).toMatchObject({ title: "CPS 234 Information Security", effectiveDate: "2019-07-01", url: "https://www.apra.gov.au/standards/cps-234" });
    expect(rules[0]?.rawText.startsWith("CPS 234 Information Security requires entities to maintain")).toBe(true);
    expect(rules[0]?.rawText).toContain("notify APRA of material information security incidents.");
    // The CPS 234 page has its text inline, so only the stub CPG 234 page reads its PDF.
    expect(pdfToTextImpl).toHaveBeenCalledTimes(1);
    expect(rules[2]?.rawText.endsWith("information security policy framework.")).toBe(true);
    // CPS 230's page 404s, so the listing description stands in.
    expect(rules[1]?.rawText).toBe("This standard requires an entity to effectively manage its operational risks.");
    expect(rules[3]).toMatchObject({
      title: "Superannuation Data Transformation: Phase 2 Depth (consultation, open until 6 November 2026)",
      effectiveDate: "2026-10-23",
      rawText: "APRA undertook a multi-year project to upgrade the breadth, depth and quality of its superannuation data collection.",
    });

    const short = await fetchApraRules({ fetchImpl, pdfToTextImpl, maxItems: 1, maxChars: 100, includePdf: false, consultationsUrl: null });
    expect(short).toHaveLength(1);
    expect(short[0]?.rawText).toHaveLength(100);
  });

  it("keeps the standards when the consultations listing fails", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/prudential-and-reporting-standards")) return new Response(fixture("apra-standards.html"));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;
    const rules = await fetchApraRules({ fetchImpl, maxItems: 2, includePdf: false });
    expect(rules.map((r) => r.externalId)).toEqual(["cps-234", "cps-230"]);
  });
});
