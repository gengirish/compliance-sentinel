import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseAmendmentCelexIds, parseEurLexDocument } from "../src/scrape/eurLex.playwright.js";
import { buildSearchUrl, extractRuleText, fetchFederalRegisterRules } from "../src/scrape/federalRegister.js";

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
