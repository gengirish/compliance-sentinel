import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { EDPB_SOURCE, fetchEdpbRules, parseEdpbDocumentPage, parseEdpbFeed } from "../src/scrape/edpb.js";

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

const PAGE_URL = "https://www.edpb.europa.eu/documents/guideline/guidelines-022026-on-anonymisation_en";

describe("EDPB publications feed", () => {
  it("reads title, link, date and topics, collapsing the feed's double spaces", () => {
    const items = parseEdpbFeed(fixture("edpb-rss.xml"));
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      title: "Guidelines 02/2026 on Anonymisation",
      link: PAGE_URL,
      date: "2026-07-08",
      topics: ["Anonymisation / pseudonymisation"],
    });
    expect(items[1]?.title).toBe(
      "Opinion 27/2026 on the draft decision of the Irish Supervisory Authority regarding the Controller Binding Corporate Rules of the HCL Tech Group",
    );
    expect(items[2]).toMatchObject({ date: null, topics: [] });
    expect(EDPB_SOURCE).toMatchObject({ name: "edpb", kind: "api" });
  });

  it("reads a document page: title, type, date, header text and the latest-version PDF", () => {
    const page = parseEdpbDocumentPage(fixture("edpb-page.html"), PAGE_URL);
    expect(page.title).toBe("Guidelines 02/2026 on Anonymisation");
    expect(page.documentType).toBe("Guideline");
    expect(page.date).toBe("2026-07-08");
    expect(page.pdfUrl).toBe("https://www.edpb.europa.eu/system/files/2026-09/edpb_guidelines_202602_anonymisation_v1_en_0.pdf");
    const lines = page.text.split("\n");
    expect(lines).toContain("Public consultation closed");
    for (const noise of ["Downloadable documents", "Related topics:", "EDPB Annual Report 2025", "EDPB footer text.", "Documents"]) {
      expect(lines).not.toContain(noise);
    }
  });

  it("appends the PDF text and falls back to the feed title when a page is gone", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/feed/publications_en")) return new Response(fixture("edpb-rss.xml"));
      if (url === PAGE_URL) return new Response(fixture("edpb-page.html"));
      if (url.endsWith("_v1_en_0.pdf")) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;
    const pdfToTextImpl = vi.fn(async () => "Controllers must assess the means reasonably likely to be used to re-identify data.");

    const rules = await fetchEdpbRules({ fetchImpl, pdfToTextImpl });
    expect(rules.map((r) => r.externalId)).toEqual([
      "guidelines-022026-on-anonymisation_en",
      "opinion-272026-on-the-draft-decision-of-the-irish-supervisory_en",
      "guidelines-12020-on-processing-personal-data-in-the-context-of-connected_en",
    ]);
    expect(rules[0]).toMatchObject({ title: "Guidelines 02/2026 on Anonymisation", effectiveDate: "2026-07-08", url: PAGE_URL });
    expect(rules[0]?.rawText.startsWith("Guidelines 02/2026 on Anonymisation\nGuideline")).toBe(true);
    expect(rules[0]?.rawText.endsWith("reasonably likely to be used to re-identify data.")).toBe(true);
    expect(pdfToTextImpl).toHaveBeenCalledTimes(1);
    // The opinion's page 404s, so the feed title and topics stand in.
    expect(rules[1]?.rawText).toBe(
      "Opinion 27/2026 on the draft decision of the Irish Supervisory Authority regarding the Controller Binding Corporate Rules of the HCL Tech Group\nBinding Corporate Rules\nTools for transfers and derogations",
    );

    const short = await fetchEdpbRules({ fetchImpl, pdfToTextImpl, includePdf: false, maxItems: 1, maxChars: 20 });
    expect(short).toHaveLength(1);
    expect(short[0]?.rawText).toBe("Guidelines 02/2026 o");
  });
});
