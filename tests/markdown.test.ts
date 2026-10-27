import { describe, expect, it } from "vitest";
import type { Finding } from "../src/graph/types.js";
import { COMMENT_MARKER, renderMarkdownSummary } from "../src/report/markdown.js";

const finding = (over: Partial<Finding>): Finding => ({
  ruleId: 1,
  obligationId: "1-0",
  obligation: "Card numbers must never be written to logs",
  status: "violation",
  severity: "critical",
  rationale: "",
  evidence: [{ path: "src/routes/payments.js", start_line: 12, end_line: 12, excerpt: "console.log(...)" }],
  citationChunkIds: [3],
  verification: [],
  ...over,
});

const base = {
  ruleTitles: new Map([[1, "PCI DSS v4.0.1 | demo"]]),
  repo: "acme/portal",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  analyst: "claude",
  costUsd: 0.4512,
};

describe("renderMarkdownSummary", () => {
  it("lists violations most severe first, with linked file:line at the audited commit", () => {
    const md = renderMarkdownSummary({
      ...base,
      repoWebUrl: "https://github.com/acme/portal",
      findings: [
        finding({ severity: "high", obligation: "Use unique IDs", evidence: [{ path: "src/config.js", start_line: 3, end_line: 6, excerpt: "" }] }),
        finding({}),
        finding({ status: "compliant", severity: "low" }),
      ],
    });
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain("| 2 | 1 | 1 | 0 | 1 |");
    expect(md.indexOf("Card numbers")).toBeLessThan(md.indexOf("Use unique IDs"));
    expect(md).toContain(
      "[`src/routes/payments.js:12`](https://github.com/acme/portal/blob/0123456789abcdef0123456789abcdef01234567/src/routes/payments.js#L12)",
    );
    expect(md).toContain("#L3-L6");
    expect(md).toContain("PCI DSS v4.0.1 \\| demo");
    expect(md).toContain("$0.45");
  });

  it("does not link a working-tree snapshot and says when the offline baseline ran", () => {
    const md = renderMarkdownSummary({ ...base, commitSha: "content-abc", analyst: "offline-keyword-baseline", repoWebUrl: "https://github.com/acme/portal", findings: [finding({})] });
    expect(md).toContain("`src/routes/payments.js:12`");
    expect(md).not.toContain("/blob/");
    expect(md).toContain("offline keyword baseline");
  });

  it("caps the list and counts the rest", () => {
    const many = Array.from({ length: 4 }, (_, i) => finding({ obligationId: `1-${i}` }));
    const md = renderMarkdownSummary({ ...base, findings: many, maxFindings: 2 });
    expect(md).toContain("2 more violation(s)");
  });
});
