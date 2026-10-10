import { describe, expect, it } from "vitest";
import { verifyAssessment, type VerifyContext } from "../src/graph/nodes/verifyCitations.js";
import type { Assessment, Obligation } from "../src/graph/types.js";

const obligation: Obligation = {
  id: "7-0",
  ruleId: 7,
  obligation: "Personal data must not be logged.",
  appliesTo: "application code",
  technicalControls: ["console.log"],
  sourceChunkIds: [101],
};

const ctx: VerifyContext = {
  // 101 and 102 belong to rule 7; 201 belongs to another rule.
  chunkRule: new Map([
    [101, 7],
    [102, 7],
    [201, 8],
  ]),
  files: new Map([["src/app.js", ["const a = 1;", "console.log(user.ssn);", "module.exports = a;"]]]),
};

const assessment = (overrides: Partial<Assessment> = {}): Assessment => ({
  status: "violation",
  severity: "critical",
  rationale: "The log statement writes a social security number.",
  evidence: [{ path: "src/app.js", start_line: 2, end_line: 2 }],
  citation_chunk_ids: [101],
  ...overrides,
});

describe("verifyAssessment", () => {
  it("keeps a verdict whose citations all check out and attaches the real excerpt", () => {
    const finding = verifyAssessment(obligation, assessment(), ctx);
    expect(finding.status).toBe("violation");
    expect(finding.severity).toBe("critical");
    expect(finding.citationChunkIds).toEqual([101]);
    expect(finding.evidence).toEqual([
      { path: "src/app.js", start_line: 2, end_line: 2, excerpt: "console.log(user.ssn);" },
    ]);
    expect(finding.verification).toEqual([]);
  });

  it("drops a chunk id that does not exist but keeps the valid one", () => {
    const finding = verifyAssessment(obligation, assessment({ citation_chunk_ids: [101, 999] }), ctx);
    expect(finding.status).toBe("violation");
    expect(finding.citationChunkIds).toEqual([101]);
    expect(finding.verification.join(" ")).toContain("999");
  });

  it("drops a chunk that belongs to a different rule", () => {
    const finding = verifyAssessment(obligation, assessment({ citation_chunk_ids: [201] }), ctx);
    expect(finding.status).toBe("needs_review");
    expect(finding.verification.join(" ")).toContain("different rule");
  });

  it("downgrades when the only code citation is a file that was never indexed", () => {
    const finding = verifyAssessment(
      obligation,
      assessment({ evidence: [{ path: "src/invented.js", start_line: 1, end_line: 3 }] }),
      ctx,
    );
    expect(finding.status).toBe("needs_review");
    expect(finding.evidence).toEqual([]);
    expect(finding.verification.join(" ")).toContain("not in the audited snapshot");
  });

  it.each([
    ["past the end of the file", { start_line: 2, end_line: 40 }],
    ["line zero", { start_line: 0, end_line: 1 }],
    ["an inverted range", { start_line: 3, end_line: 2 }],
  ])("rejects a range that is %s", (_label, range) => {
    const finding = verifyAssessment(obligation, assessment({ evidence: [{ path: "src/app.js", ...range }] }), ctx);
    expect(finding.status).toBe("needs_review");
    expect(finding.evidence).toEqual([]);
  });

  it("keeps the verdict when one of two code citations is bad", () => {
    const finding = verifyAssessment(
      obligation,
      assessment({
        evidence: [
          { path: "src/app.js", start_line: 2, end_line: 2 },
          { path: "src/missing.js", start_line: 1, end_line: 1 },
        ],
      }),
      ctx,
    );
    expect(finding.status).toBe("violation");
    expect(finding.evidence).toHaveLength(1);
  });

  it("downgrades a compliant verdict that cites no code", () => {
    const finding = verifyAssessment(obligation, assessment({ status: "compliant", severity: "low", evidence: [] }), ctx);
    expect(finding.status).toBe("needs_review");
  });

  it("downgrades a verdict that cites no regulation chunk", () => {
    const finding = verifyAssessment(obligation, assessment({ citation_chunk_ids: [] }), ctx);
    expect(finding.status).toBe("needs_review");
    // A review item still points at the chunks the obligation was extracted from.
    expect(finding.citationChunkIds).toEqual([101]);
  });

  it("forces compliant findings to low severity", () => {
    const finding = verifyAssessment(obligation, assessment({ status: "compliant", severity: "critical" }), ctx);
    expect(finding.status).toBe("compliant");
    expect(finding.severity).toBe("low");
  });

  it("leaves needs_review untouched and does not add a downgrade note", () => {
    const finding = verifyAssessment(
      obligation,
      assessment({ status: "needs_review", severity: "medium", evidence: [], citation_chunk_ids: [101] }),
      ctx,
    );
    expect(finding.status).toBe("needs_review");
    expect(finding.verification).toEqual([]);
  });
});
