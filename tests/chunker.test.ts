import { describe, expect, it } from "vitest";
import { chunkCode, chunkRuleText, estimateTokens, splitSections } from "../src/rag/chunker.js";

const sentence = "The controller shall implement appropriate technical and organisational measures. ";

describe("splitSections", () => {
  it("splits EU articles and US sections on their headings", () => {
    const text = [
      "Preamble line.",
      "Article 5 Principles",
      "Body of article five.",
      "Article 6a",
      "Body of article six a.",
      "§ 314.4 Elements",
      "Body of section.",
      "Sec. 12 Definitions",
      "Body of sec.",
    ].join("\n");
    expect(splitSections(text).map((s) => s.ref)).toEqual([null, "Article 5", "Article 6a", "§ 314.4", "Sec. 12"]);
  });

  it("does not treat a mid-sentence reference as a heading", () => {
    const text = "Article 33 Notification\nNotify the authority competent in accordance with\nArticle 55, unless the breach is unlikely to result in a risk to the rights and freedoms of natural persons, in which case the controller documents it and keeps the record available for inspection.";
    expect(splitSections(text)).toHaveLength(1);
  });
});

describe("chunkRuleText", () => {
  it("keeps each section as its own chunk with its reference", () => {
    const text = `Article 1 Scope\n${sentence.repeat(6)}\nArticle 2 Duties\n${sentence.repeat(6)}`;
    const chunks = chunkRuleText(text);
    expect(chunks.map((c) => c.sectionRef)).toEqual(["Article 1", "Article 2"]);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
    expect(chunks[1]?.text.startsWith("Article 2 Duties")).toBe(true);
  });

  it("merges a tiny fragment into the section that follows it", () => {
    const text = `Short title line.\nArticle 1 Scope\n${sentence.repeat(6)}`;
    const chunks = chunkRuleText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sectionRef).toBe("Article 1");
    expect(chunks[0]?.text).toContain("Short title line.");
  });

  it("splits an oversized section under the token ceiling and repeats an overlap", () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `(${i}) ${sentence.repeat(4)}`).join("\n");
    const chunks = chunkRuleText(`Article 9 Long\n${paragraphs}`, { maxTokens: 300 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(300);
      expect(chunk.sectionRef).toBe("Article 9");
    }
    // The tail of one chunk reappears at the head of the next.
    const tail = chunks[0]!.text.slice(-60);
    expect(chunks[1]!.text).toContain(tail);
  });

  it("hard-splits a single run of text with no sentence breaks", () => {
    const chunks = chunkRuleText("x".repeat(5_000), { maxTokens: 250 });
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1_000);
  });

  it("returns nothing for empty text", () => {
    expect(chunkRuleText("   \n  ")).toEqual([]);
  });
});

describe("chunkCode", () => {
  it("produces 1-based inclusive windows that cover every line", () => {
    const source = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunkCode(source, 40, 8);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 40 });
    expect(chunks[1]?.startLine).toBe(33);
    expect(chunks.at(-1)?.endLine).toBe(100);
    for (const chunk of chunks) {
      const lines = chunk.text.split("\n");
      expect(lines[0]).toBe(`line ${chunk.startLine}`);
      expect(lines.at(-1)).toBe(`line ${chunk.endLine}`);
    }
  });

  it("handles a file shorter than one window and a trailing newline", () => {
    expect(chunkCode("a\nb\n")).toEqual([{ startLine: 1, endLine: 2, text: "a\nb" }]);
  });
});
