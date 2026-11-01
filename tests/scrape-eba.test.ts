import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  EBA_DOCUMENT_TYPES,
  EBA_SOURCE,
  ebaExternalId,
  extractEbaPressReleaseText,
  fetchEbaRules,
  listingUrl,
  parseEbaListing,
} from "../src/scrape/eba.js";

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

const TCB_PDF =
  "https://www.eba.europa.eu/sites/default/files/2026-07/7e51bdcd-7c73-4f94-b31c-03375fe53359/Final%20Report%20on%20Guidelines%20on%20the%20authorisation%20of%20third-country%20branches%20.pdf";

describe("EBA publications listing", () => {
  it("reads PDF entries with date and press release, skipping annex spreadsheets", () => {
    const items = parseEbaListing(fixture("eba-listing.html"));
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "Final report on Guidelines on the sound management of third-party risk related to non-ICT services",
      url: "https://www.eba.europa.eu/sites/default/files/2026-09/dc9ccbb3-79b9-493d-b693-c21adeffbcc9/Final%20report%20on%20GL%20on%20third-party%20risk%20management.pdf",
      date: "2026-09-21",
      pressReleaseUrl: null,
    });
    // The zero-width space in front of the title is dropped.
    expect(items[1]).toEqual({
      title: "Final Report on Guidelines on the authorisation of third-country branches",
      url: TCB_PDF,
      date: "2026-07-07",
      pressReleaseUrl:
        "https://www.eba.europa.eu/publications-and-media/press-releases/eba-publishes-final-guidelines-authorisation-third-country-branches-under-capital-requirements",
    });
    expect(ebaExternalId(TCB_PDF)).toBe("7e51bdcd-7c73-4f94-b31c-03375fe53359");
    expect(listingUrl(EBA_DOCUMENT_TYPES.guidelines)).toBe(
      "https://www.eba.europa.eu/publications-and-media/publications?text=&document_type=250&media_topics=All",
    );
    expect(EBA_SOURCE).toMatchObject({ name: "eba", kind: "api" });
  });

  it("extracts the press release body without the documents box, related content and contacts", () => {
    const lines = extractEbaPressReleaseText(fixture("eba-press-release.html")).split("\n");
    expect(lines[0]).toBe(
      "The European Banking Authority (EBA) today published its final Guidelines on authorisation of third-country credit institutions to set-up a third-country branch (TCB) in a Member State.",
    );
    expect(lines).toContain("Legal basis and background");
    expect(lines).toContain("The EBA has developed these Guidelines in accordance with Article 48c(8) of Directive 2013/36/EU.");
    for (const noise of ["Press Release", "7 July 2026", "(885.47 KB - PDF)", "Related activity", "Franca Rosa Congiu", "EBA footer text."]) {
      expect(lines).not.toContain(noise);
    }
  });

  it("merges the type listings newest first, once each, with press release and PDF text", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("document_type=250")) return new Response(fixture("eba-listing.html"));
      if (url.includes("document_type=248")) return new Response(fixture("eba-listing-rts.html"));
      if (url.includes("third-country-branches-under-capital-requirements")) return new Response(fixture("eba-press-release.html"));
      if (url.includes("dc9ccbb3") || url.includes("7e51bdcd")) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;
    const pdfToTextImpl = vi.fn(async () => "Competent authorities should assess the application within six months.");
    const documentTypes = [EBA_DOCUMENT_TYPES.guidelines, EBA_DOCUMENT_TYPES.draftRts];

    const rules = await fetchEbaRules({ fetchImpl, pdfToTextImpl, documentTypes });
    expect(rules.map((r) => r.externalId)).toEqual([
      "2500fd3b-78b4-4ebc-9316-0c8e209047a4",
      "dc9ccbb3-79b9-493d-b693-c21adeffbcc9",
      "7e51bdcd-7c73-4f94-b31c-03375fe53359",
    ]);
    expect(rules[2]).toMatchObject({
      title: "Final Report on Guidelines on the authorisation of third-country branches",
      effectiveDate: "2026-07-07",
      url: TCB_PDF,
    });
    expect(rules[2]?.rawText.startsWith("The European Banking Authority (EBA) today published")).toBe(true);
    expect(rules[2]?.rawText.endsWith("within six months.")).toBe(true);
    // No press release: the PDF text alone.
    expect(rules[1]?.rawText).toBe("Competent authorities should assess the application within six months.");
    // Press release and PDF both 404: the title stands in.
    expect(rules[0]?.rawText).toBe(rules[0]?.title);

    const noPdf = await fetchEbaRules({ fetchImpl, pdfToTextImpl, documentTypes, includePdf: false, maxItems: 2, maxChars: 40 });
    expect(noPdf.map((r) => r.rawText)).toEqual([
      "Regulatory Technical Standards on pruden",
      "Final report on Guidelines on the sound ",
    ]);
    expect(pdfToTextImpl).toHaveBeenCalledTimes(2);
  });
});
