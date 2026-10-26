import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseAmendmentCelexIds, parseEurLexDocument } from "../src/scrape/eurLex.playwright.js";
import { extractFcaPageText, fcaExternalId, fetchFcaRules, normalizeFcaType, parseFcaFeed } from "../src/scrape/fcaPublications.js";
import { buildSearchUrl, extractRuleText, fetchFederalRegisterRules } from "../src/scrape/federalRegister.js";
import { masExternalId, parseMasCircularPage, parseMasDate, parseMasListing } from "../src/scrape/masCirculars.playwright.js";
import { buildSecSearchUrl, fetchSecRules, SEC_SOURCE } from "../src/scrape/secRules.js";

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

describe("EUR-Lex parsing", () => {
  it("extracts title, article text and the application date from a document page", () => {
    const doc = parseEurLexDocument(fixture("eurlex-document.html"));
    expect(doc.title).toContain("REGULATION (EU) 2099/1");
    expect(doc.effectiveDate).toBe("25 May 2099");
    const lines = doc.text.split("\n");
    expect(lines).toContain("Article 1");
    expect(lines).toContain("This Regulation lays down rules relating to the protection of test data.");
    expect(lines).toContain("controllers shall keep records;");
    expect(doc.text).not.toContain("tracking");
    // Nested blocks must not be emitted twice.
    expect(lines.filter((l) => l === "Subject matter")).toHaveLength(1);
  });

  it("lists acts that amend or correct the base act, once each", () => {
    const ids = parseAmendmentCelexIds(fixture("eurlex-all.html"), "32016R0679");
    expect(ids.sort()).toEqual(["32016R0679R(02)", "32099R0001"]);
  });
});

describe("Federal Register client", () => {
  it("builds a search for final rules, newest first", () => {
    const url = new URL(buildSearchUrl({ term: "data security", agencies: ["federal-trade-commission"], perPage: 3 }));
    expect(url.searchParams.get("conditions[term]")).toBe("data security");
    expect(url.searchParams.getAll("conditions[type][]")).toEqual(["RULE"]);
    expect(url.searchParams.getAll("conditions[agencies][]")).toEqual(["federal-trade-commission"]);
    expect(url.searchParams.get("order")).toBe("newest");
    expect(url.searchParams.get("per_page")).toBe("3");
    expect(url.searchParams.getAll("fields[]")).toContain("raw_text_url");
  });

  it("keeps the summary and the regulatory text, dropping the preamble commentary", () => {
    const raw = `<html><body><pre>
ACTION: Final rule.

SUMMARY: The Commission amends the <a href="x">Rule</a> to require
written security programs.

DATES: Effective June 23, 2025.

SUPPLEMENTARY INFORMATION:
I. Background
Hundreds of pages of commentary mentioning List of Subjects in passing.

List of Subjects in 16 CFR Part 312

  Privacy, Safety.

Sec. 312.8 Confidentiality, security, and integrity.
The operator must establish reasonable procedures.
</pre></body></html>`;
    const text = extractRuleText(raw);
    expect(text.startsWith("SUMMARY: The Commission amends the Rule to require")).toBe(true);
    expect(text).not.toContain("DATES:");
    expect(text).not.toContain("Background");
    expect(text).not.toContain("<a href");
    expect(text).toContain("Sec. 312.8 Confidentiality");
    expect(text.indexOf("List of Subjects in 16 CFR Part 312")).toBeGreaterThan(0);
  });

  it("returns plain text unchanged when there is no regulatory-text marker", () => {
    expect(extractRuleText("  A short notice.  ")).toBe("A short notice.");
  });

  it("maps documents to rules, fetching full text and falling back to the abstract", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("documents.json")) {
        return Response.json({
          results: [
            { document_number: "2026-00001", title: "Rule one", html_url: "https://fr.test/1", raw_text_url: "https://fr.test/1.txt", abstract: "abstract one", effective_on: "2026-03-01", publication_date: "2026-01-01" },
            { document_number: "2026-00002", title: "Rule two", html_url: "https://fr.test/2", raw_text_url: "https://fr.test/2.txt", abstract: "abstract two", effective_on: null, publication_date: "2026-01-02" },
            { document_number: "2026-00003", title: "No text", html_url: "https://fr.test/3", raw_text_url: null, abstract: null },
          ],
        });
      }
      if (url.endsWith("/1.txt")) return new Response("FULL TEXT ONE ".repeat(20));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;

    const rules = await fetchFederalRegisterRules({ fetchImpl, term: "x", agencies: [], perPage: 3, maxChars: 100 });
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ externalId: "2026-00001", title: "Rule one", effectiveDate: "2026-03-01", url: "https://fr.test/1" });
    expect(rules[0]?.rawText).toHaveLength(100);
    // Full text 404s, so the abstract is used; with no effective date the publication date stands in.
    expect(rules[1]).toMatchObject({ externalId: "2026-00002", rawText: "abstract two", effectiveDate: "2026-01-02" });
  });

  it("fails loudly on a client error instead of returning an empty list", async () => {
    const fetchImpl = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    await expect(fetchFederalRegisterRules({ fetchImpl, term: "x", agencies: [], perPage: 1 })).rejects.toThrow("HTTP 400");
  });
});

describe("SEC rules client", () => {
  it("searches the Federal Register for final rules by the SEC only", () => {
    const url = new URL(buildSecSearchUrl({ term: "customer information", perPage: 4 }));
    expect(url.searchParams.getAll("conditions[agencies][]")).toEqual(["securities-and-exchange-commission"]);
    expect(url.searchParams.getAll("conditions[type][]")).toEqual(["RULE"]);
    expect(url.searchParams.get("conditions[term]")).toBe("customer information");
    expect(url.searchParams.get("per_page")).toBe("4");
    expect(SEC_SOURCE.name).toBe("sec");
  });

  it("maps SEC documents to rules with the regulatory text, capped at maxChars", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("documents.json")) {
        return Response.json({
          results: [
            { document_number: "2024-11116", title: "Regulation S-P", html_url: "https://fr.test/sp", raw_text_url: "https://fr.test/sp.txt", abstract: "abstract", effective_on: "2024-08-02", publication_date: "2024-06-03" },
          ],
        });
      }
      return new Response("<pre>SUMMARY: Safeguards.\n\nDATES: now.\n\nList of Subjects\n\nSec. 248.30 Procedures to safeguard customer records.</pre>");
    }) as unknown as typeof fetch;

    const rules = await fetchSecRules({ fetchImpl, term: "safeguards", perPage: 1, maxChars: 60 });
    expect(new URL(requested[0]!).searchParams.getAll("conditions[agencies][]")).toEqual(["securities-and-exchange-commission"]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ externalId: "2024-11116", title: "Regulation S-P", effectiveDate: "2024-08-02", url: "https://fr.test/sp" });
    expect(rules[0]?.rawText.startsWith("SUMMARY: Safeguards.")).toBe(true);
    expect(rules[0]?.rawText).toHaveLength(60);
  });
});

describe("FCA publications feed", () => {
  it("reads items, categories and both date formats, skipping items without a link", () => {
    const items = parseFcaFeed(fixture("fca-rss.xml"));
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      title: "PS99/1: Operational resilience for test firms",
      link: "https://www.fca.org.uk/publications/policy-statements/ps99-1-operational-resilience-test-firms",
      category: "Policy statements",
      pubDate: "2026-10-23",
    });
    expect(items[0]?.summary).toBe("We set out final rules requiring test firms to identify important business services.");
    // Whitespace inside the title collapses; an RFC 822 date is accepted too.
    expect(items[1]).toMatchObject({ title: "CP99/2: Financial crime guide updates", category: "Consultation papers", pubDate: "2026-10-22" });
    expect(items[2]).toMatchObject({ category: "Data", pubDate: null });
  });

  it("compares publication types loosely and takes the URL slug as the id", () => {
    for (const spelling of ["Policy statements", "policy statement", "Policy-Statement", " POLICY STATEMENTS "]) {
      expect(normalizeFcaType(spelling)).toBe("policystatement");
    }
    expect(fcaExternalId("https://www.fca.org.uk/publications/policy-statements/ps21-3-building-operational-resilience")).toBe(
      "ps21-3-building-operational-resilience",
    );
    expect(fcaExternalId("https://www.fca.org.uk/data/access-cash-coverage-uk-2026-h1/")).toBe("access-cash-coverage-uk-2026-h1");
  });

  it("extracts the article body of a publication page and drops navigation, feedback and footer", () => {
    const lines = extractFcaPageText(fixture("fca-page.html")).split("\n");
    expect(lines[0]).toBe("We set out final rules requiring test firms to identify their important business services. Read PS99/1 (PDF)");
    expect(lines).toContain("Who this applies to");
    expect(lines).toContain("Identify each important business service by 31 March 2027.");
    expect(lines).toContain("Rules in force");
    for (const noise of ["Firms", "Home > Publications", "Timeline widget text", "Was this page useful? Yes / No", "Related: CP99/2 Financial crime guide updates", "Copyright 2026 FCA. Cookies policy."]) {
      expect(lines).not.toContain(noise);
    }
    expect(lines.join("\n")).not.toContain("dataLayer");
  });

  it("keeps only the configured types, reads each page and falls back to the feed summary", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/rss.xml")) return new Response(fixture("fca-rss.xml"));
      if (url.includes("ps99-1")) return new Response(fixture("fca-page.html"));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;

    const rules = await fetchFcaRules({ fetchImpl, types: ["Policy Statement", "consultation-papers"], maxChars: 80 });
    expect(rules.map((r) => r.externalId)).toEqual(["ps99-1-operational-resilience-test-firms", "cp99-2-financial-crime-guide-updates"]);
    expect(rules[0]).toMatchObject({ title: "PS99/1: Operational resilience for test firms", effectiveDate: "2026-10-23" });
    expect(rules[0]?.rawText).toHaveLength(80);
    // The consultation paper's page 404s, so the feed summary stands in.
    expect(rules[1]?.rawText).toBe("We are consulting on changes to the guide.");
    // The "Data" item was filtered out, so its page was never requested.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))).not.toContain(
      "https://www.fca.org.uk/data/access-cash-coverage-uk-2026-h1/",
    );
  });

  it("returns every type when no filter is configured, honouring maxItems", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/rss.xml")) return new Response(fixture("fca-rss.xml"));
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;
    const rules = await fetchFcaRules({ fetchImpl, types: [], maxItems: 2 });
    expect(rules.map((r) => r.externalId)).toEqual(["ps99-1-operational-resilience-test-firms", "cp99-2-financial-crime-guide-updates"]);
  });
});

describe("MAS circulars parsing", () => {
  it("lists circular cards once each with their date and summary", () => {
    const items = parseMasListing(fixture("mas-listing.html"));
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "Circular on Test Report Templates",
      url: "https://www.mas.gov.sg/regulation/circulars/circular-on-test-report-templates",
      date: "2026-09-30",
      summary: "This circular informs licensed test entities of the publication of new report templates.",
    });
    expect(items[1]).toMatchObject({
      title: "ID 10/26 MAS Response to the Consultation Paper on Test Capital",
      url: "https://www.mas.gov.sg/regulation/circulars/id10_26",
      date: "2026-09-04",
    });
    expect(masExternalId(items[1]!.url)).toBe("id10_26");
  });

  it("reads a circular page: title, body lines, reference number and the first PDF link", () => {
    const pageUrl = "https://www.mas.gov.sg/regulation/circulars/circular-on-test-report-templates";
    const circular = parseMasCircularPage(fixture("mas-circular.html"), pageUrl);
    expect(circular.title).toBe("Circular on Test Report Templates");
    expect(circular.pdfUrl).toBe(
      "https://www.mas.gov.sg/-/media/mas-media-library/regulation/circulars/test/circular-on-test-report-templates.pdf",
    );
    expect(circular.refNo).toBe("CMI 05/2026");
    const lines = circular.text.split("\n");
    expect(lines).toContain("Entities must submit the misconduct report within 14 days of the misconduct being discovered.");
    expect(lines).toContain("Requirements");
    expect(circular.text).not.toContain("Privacy statement");
    expect(circular.text).not.toContain("tracker");
    expect(lines).not.toContain("Home");
  });

  it("parses MAS dates and tolerates missing ones", () => {
    expect(parseMasDate("Published 04 September 2026")).toBe("2026-09-04");
    expect(parseMasDate("Date withheld")).toBeNull();
    expect(parseMasDate(undefined)).toBeNull();
  });
});
