import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fetchOsfiRules, OSFI_SOURCE, parseOsfiGuidancePage, parseOsfiLibrary } from "../src/scrape/osfi.js";

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

const LIBRARY = "https://www.osfi-bsif.gc.ca/en/guidance/guidance-library";
const B10 = `${LIBRARY}/third-party-risk-management-guideline`;

describe("OSFI guidance library", () => {
  it("reads the library table: title, link, date, type and sectors", () => {
    const items = parseOsfiLibrary(fixture("osfi-guidance-library.html"));
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({
      title: "2026 Annual Update to the Manual of Reporting Forms and Instructions for Deposit-Taking Institutions",
      url: `${LIBRARY}/2026-annual-update-manual-reporting-forms-instructions-deposit-taking-institutions`,
      date: "2026-10-22",
      publicationType: "Letter",
      category: null,
      sectors: ["Banks", "Foreign Bank Branches", "Trust and Loan Companies"],
    });
    expect(items[3]).toMatchObject({
      title: "Third-Party Risk Management Guideline",
      url: B10,
      date: "2023-04-30",
      publicationType: "Guideline",
      category: "Sound Business and Financial Practices",
    });
    expect(OSFI_SOURCE).toMatchObject({ name: "osfi", kind: "api", url: LIBRARY });
  });

  it("reads a guideline page: number, metadata and body, with footnotes inline", () => {
    const page = parseOsfiGuidancePage(fixture("osfi-guideline-page.html"));
    expect(page).toMatchObject({
      title: "Third-Party Risk Management Guideline",
      number: "B-10",
      publicationType: "Guideline",
      date: "2023-04-30",
    });
    const lines = page.text.split("\n");
    expect(lines[0]).toBe("A. Overview");
    expect(lines).toContain("A1. Purpose and scope");
    // The footnote's escaped HTML is reduced to its text.
    expect(page.text).toContain(
      "[1: In accordance with supervisory information requirements set out in the Bank Act, the Insurance Companies Act, and the Trust and Loan Companies Act.]",
    );
    expect(page.text).not.toContain("<a href");
    // The information box, table of contents and page chrome stay out.
    expect(page.text).not.toContain("Publication type");
    expect(page.text).not.toContain("Generate PDF");
    expect(page.text).not.toContain("Date modified");
  });

  it("fetches the listed guidance, filters by type and puts the number in the title", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === LIBRARY) return new Response(fixture("osfi-guidance-library.html"));
      if (url === B10) return new Response(fixture("osfi-guideline-page.html"));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;

    const rules = await fetchOsfiRules({ fetchImpl, types: ["guideline"] });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      externalId: "third-party-risk-management-guideline",
      title: "B-10 Third-Party Risk Management Guideline",
      effectiveDate: "2023-04-30",
      url: B10,
    });
    expect(rules[0]?.rawText).toContain("OSFI expects the FRFI to manage the risks related to all third-party arrangements");

    // Unfiltered, the letters' pages 404 and are skipped; the guideline is truncated at maxChars.
    const all = await fetchOsfiRules({ fetchImpl, maxChars: 100 });
    expect(all.map((r) => r.externalId)).toEqual(["third-party-risk-management-guideline"]);
    expect(all[0]?.rawText).toHaveLength(100);

    const first = await fetchOsfiRules({ fetchImpl, maxItems: 1 });
    expect(first).toHaveLength(0);
  });
});
