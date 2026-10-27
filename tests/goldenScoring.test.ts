import { describe, expect, it } from "vitest";
import { scoreGolden } from "../src/eval/golden.js";
import { searchCoverage } from "../src/graph/evidence.js";
import type { Finding } from "../src/graph/types.js";

function violation(obligation: string, path: string): Finding {
  return {
    ruleId: 1,
    obligationId: "1-0",
    obligation,
    status: "violation",
    severity: "high",
    evidence: [{ path, start_line: 1, end_line: 3, excerpt: "" }],
    citationChunkIds: [1],
    rationale: obligation,
    verification: [],
  };
}

describe("scoreGolden with confirmed gaps", () => {
  it("counts a missing-MFA finding on auth.js as a confirmed gap, not a flagged compliant area", () => {
    const score = scoreGolden([
      violation("Personal data must not be written to logs", "src/routes/signup.js"),
      violation("Require multi-factor authentication for administrative access", "src/middleware/auth.js"),
    ]);
    expect(score.found).toEqual(["pii-in-logs"]);
    expect(score.confirmedGaps).toEqual(["no-mfa"]);
    expect(score.falselyFlagged).toEqual([]);
    expect(score.precision).toBe(0.5);
    expect(score.precisionWithConfirmedGaps).toBe(1);
  });

  it("still flags a compliant area for a finding that matches no gap", () => {
    const score = scoreGolden([violation("TLS must be enforced on every request", "src/middleware/https.js")]);
    expect(score.falselyFlagged).toEqual(["tls-enforced"]);
    expect(score.unexplained).toHaveLength(1);
    expect(score.precisionWithConfirmedGaps).toBe(0);
  });
});

describe("searchCoverage", () => {
  const files = new Map([
    ["src/jobs/index.js", ["setInterval(sendReminders, ONE_HOUR);"]],
    ["src/routes/users.js", ["await db.query('DELETE FROM sessions WHERE expired');", "res.json(user);"]],
  ]);

  it("counts matching files per term across the whole index, case-insensitively", () => {
    const coverage = searchCoverage(files, ["retention", "delete", "setInterval", "ab"]);
    expect(coverage.filesSearched).toBe(2);
    expect(coverage.terms).toEqual([
      { term: "retention", files: 0 },
      { term: "delete", files: 1 },
      { term: "setInterval", files: 1 },
    ]);
    expect(coverage.paths).toEqual(["src/jobs/index.js", "src/routes/users.js"]);
    expect(coverage.pathsTruncated).toBe(false);
  });
});
