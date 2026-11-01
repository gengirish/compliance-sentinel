import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fetchPraRules, parsePraDate, parsePraFeed, parsePraPage, praExternalId } from "../src/scrape/pra.js";

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

const BASE = "https://www.bankofengland.co.uk/prudential-regulation";

describe("PRA publications feed", () => {
  it("reads the document code and kind from the title, and the publication day from pubDate", () => {
    const items = parsePraFeed(fixture("pra-rss.xml"));
    expect(items.map((i) => i.type)).toEqual(["cp", "ss", "digest", "letter", "publication", "ss"]);
    expect(items.map((i) => i.code)).toEqual(["CP14/26", "SS2/26", null, null, null, "SS9/17"]);
    expect(items[0]).toMatchObject({
      title: "CP14/26 – Review of the Senior Managers and Certification Regime (SM&CR) – Phase 2",
      date: "2026-10-22",
      summary: "Consultation paper 14/26",
    });
    // 21:00 +0100 is still the 22nd in London, and a "Z" date reads as written.
    expect(items[5]?.date).toBe("2026-03-26");
    expect(parsePraDate("1 April 2026")).toBe("2026-04-01");
    expect(parsePraDate("no date")).toBeNull();
  });

  it("keys documents by code, else by their path under /prudential-regulation/", () => {
    const items = parsePraFeed(fixture("pra-rss.xml"));
    expect(praExternalId(items[5]!)).toBe("ss9-17");
    expect(praExternalId(items[3]!)).toBe("letter-2026-thematic-feedback-on-accounting-for-ifrs-9-ecl");
  });

  it("reads an HTML document page: title, body and effective date, without page chrome", () => {
    const page = parsePraPage(fixture("pra-page.html"), `${BASE}/publication/2026/october/high-loan-to-income-lending-supervisory-statement`);
    expect(page.title).toBe("SS2/26 – High loan to income lending");
    expect(page.effectiveFrom).toBe("2026-10-28");
    expect(page.pdfUrl).toBeNull();
    const lines = page.text.split("\n");
    expect(lines).toContain("1: Introduction");
    expect(lines).toContain("1.2 This statement sets out the PRA’s expectations for firms entering into high loan to income (LTI) mortgages.[1] This SS should be read in conjunction with the requirements in the Housing Part.");
    expect(lines).toContain("For the example firm, the most recent measure of its high LTI flow is 17.5%.");
    expect(page.text).not.toContain("Browse content");
    expect(page.text).not.toContain("Other prudential regulation releases");
    expect(page.text).not.toContain("Close");
    expect(page.text).not.toContain("Bank of England footer.");
  });

  it("finds the current version's PDF on a landing page", () => {
    const page = parsePraPage(fixture("pra-pdf-page.html"), `${BASE}/publication/2017/recovery-planning-ss`);
    expect(page.title).toBe("SS9/17 - Recovery planning");
    expect(page.pdfUrl).toBe("https://www.bankofengland.co.uk/-/media/boe/files/prudential-regulation/supervisory-statement/2017/ss917-update---march-2026.pdf");
    expect(page.effectiveFrom).toBe("2026-04-01");
  });

  it("takes the PDF of a letter page that is only a download button", () => {
    const page = parsePraPage(fixture("pra-letter-page.html"), `${BASE}/letter/2026/tokenised-assets-stablecoins-and-other-cryptoasset-exposures`);
    expect(page.pdfUrl).toBe("https://www.bankofengland.co.uk/-/media/boe/files/prudential-regulation/letter/2026/tokenised-assets-stablecoins-and-other-cryptoasset-exposures.pdf");
    expect(page.effectiveFrom).toBeNull();
    expect(page.text).not.toContain("Other prudential regulation releases");
  });

  it("keeps the regulatory kinds, with page text, PDF text and feed fallbacks", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/prudential-regulation-publications")) return new Response(fixture("pra-rss.xml"));
      if (url.endsWith("/high-loan-to-income-lending-supervisory-statement")) return new Response(fixture("pra-page.html"));
      if (url.endsWith("/recovery-planning-ss")) return new Response(fixture("pra-pdf-page.html"));
      if (url.endsWith(".pdf")) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;
    const pdfToTextImpl = vi.fn(async () => "2.1 Firms should maintain a recovery plan that identifies credible recovery options.");

    const rules = await fetchPraRules({ fetchImpl, pdfToTextImpl });
    expect(rules.map((r) => r.externalId)).toEqual([
      "cp14-26",
      "ss2-26",
      "letter-2026-thematic-feedback-on-accounting-for-ifrs-9-ecl",
      "ss9-17",
    ]);
    // Its page 404s, so the feed summary stands in.
    expect(rules[0]).toMatchObject({ rawText: "Consultation paper 14/26", effectiveDate: "2026-10-22" });
    expect(rules[1]).toMatchObject({ title: "SS2/26 – High loan to income lending", effectiveDate: "2026-10-28" });
    expect(rules[1]?.rawText).toContain("high loan to income (LTI) mortgages");
    expect(rules[3]?.rawText.startsWith("First published on 11 December 2017")).toBe(true);
    expect(rules[3]?.rawText.endsWith("credible recovery options.")).toBe(true);
    expect(pdfToTextImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the page text when the PDF cannot be read, and truncates long text", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/prudential-regulation-publications")) return new Response(fixture("pra-rss.xml"));
      if (url.endsWith("/recovery-planning-ss")) return new Response(fixture("pra-pdf-page.html"));
      if (url.endsWith(".pdf")) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;
    const pdfToTextImpl = vi.fn(async () => {
      throw new Error("spawn pdftotext ENOENT");
    });

    const rules = await fetchPraRules({ fetchImpl, pdfToTextImpl, types: ["SS"], maxChars: 60 });
    expect(rules.map((r) => r.externalId)).toEqual(["ss2-26", "ss9-17"]);
    // The statement's page 404s, so the feed summary stands in.
    expect(rules[0]?.rawText).toBe("Supervisory statement 2/26");
    expect(rules[1]?.rawText).toHaveLength(60);
    expect(rules[1]?.rawText.startsWith("First published on 11 December 2017")).toBe(true);
    expect(pdfToTextImpl).toHaveBeenCalledTimes(1);
  });
});
