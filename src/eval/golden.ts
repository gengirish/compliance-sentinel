import type { Finding } from "../graph/types.js";

/** A violation planted in demo-target-app that the audit is expected to find. */
export type PlantedViolation = {
  id: string;
  description: string;
  /** The finding must cite at least one of these files... */
  files: string[];
  /** ...and talk about the right thing. */
  topic: RegExp;
};

export const PLANTED_VIOLATIONS: PlantedViolation[] = [
  {
    id: "pii-in-logs",
    description: "Personal data written to application logs",
    files: ["src/routes/signup.js", "src/routes/patients.js"],
    topic: /\blog/i,
  },
  {
    id: "no-retention-job",
    description: "No data-retention or disposal job",
    files: ["src/jobs/index.js", "src/jobs/reminders.js", "schema.sql"],
    topic: /retention|dispos|delet|storage limitation|no longer than/i,
  },
  {
    id: "plaintext-secrets",
    description: "Credentials and secrets in plaintext",
    files: ["src/config.js", "src/routes/signup.js", "schema.sql"],
    topic: /secret|credential|password|plaintext|hard-?coded|encrypt/i,
  },
  {
    id: "missing-consent",
    description: "Marketing opt-in assumed without consent capture",
    files: ["src/routes/signup.js", "schema.sql"],
    topic: /consent|opt-?in/i,
  },
  {
    id: "no-breach-notification",
    description: "Incident intake has no breach-notification step",
    files: ["src/routes/incidents.js"],
    topic: /breach|notif/i,
  },
  // PCI DSS v4.0.1, planted 2026-10-27 in src/routes/payments.js, schema.sql and src/config.js.
  {
    id: "pci-pan-in-logs",
    description: "Full card number written to the application log (PCI DSS 3.4.1)",
    files: ["src/routes/payments.js"],
    topic: /\blog/i,
  },
  {
    id: "pci-cvv-stored",
    description: "Card verification code stored after authorisation (PCI DSS 3.3.1)",
    files: ["src/routes/payments.js", "schema.sql"],
    topic: /cvv|cvc|card verification|sensitive authentication/i,
  },
  {
    id: "pci-pan-unreadable",
    description: "Card numbers stored in plaintext (PCI DSS 3.5.1)",
    files: ["schema.sql", "src/routes/payments.js"],
    topic: /unreadable|tokeni[sz]|truncat|hash|(?:card number|PAN)[^.]*encrypt|encrypt[^.]*(?:card number|PAN)/i,
  },
  {
    id: "pci-pan-plain-http",
    description: "Card data sent to the processor over plain HTTP (PCI DSS 4.2.1)",
    files: ["src/routes/payments.js"],
    topic: /https|\btls\b|in transit|transmi|strong cryptography|plain http/i,
  },
  {
    id: "pci-shared-account",
    description: "One shared login for the on-call team's admin console (PCI DSS 8.2.2)",
    files: ["src/config.js", "src/routes/admin.js"],
    topic: /shared|generic|unique (?:user )?id/i,
  },
];

/**
 * Real gaps in demo-target-app that were not deliberately planted. Claude reported them in the
 * 2026-10-27 eval runs and each was confirmed by reading the code. A violation that matches one is
 * correct, so it is scored separately from the planted set rather than counted as a false positive.
 * The strict planted-only precision is still reported, so earlier runs stay comparable.
 */
export const CONFIRMED_GAPS: PlantedViolation[] = [
  {
    id: "no-mfa",
    description: "No multi-factor authentication: requireAuth checks a bearer JWT only",
    files: ["src/middleware/auth.js", "src/routes/admin.js", "src/routes/signup.js", "src/server.js"],
    topic: /multi-?factor|\bmfa\b|two-?factor|\b2fa\b/i,
  },
  {
    id: "no-consent-withdrawal",
    description: "No route or job lets a user withdraw marketing consent",
    files: ["src/routes/signup.js", "src/jobs/reminders.js", "src/jobs/index.js", "schema.sql", "src/server.js"],
    topic: /withdraw|opt-?out|unsubscribe/i,
  },
  {
    id: "no-activity-audit-log",
    description: "No audit trail of authorised users' activity; the only logging is console.log",
    files: ["src/server.js", "src/middleware/auth.js", "src/routes/admin.js", "src/routes/patients.js", "src/routes/incidents.js"],
    topic: /monitor|audit (?:log|trail)|log(?:ging)? (?:the )?activity|activity of authori[sz]ed users/i,
  },
  {
    id: "no-retention-job-at-registration",
    description: "No retention or disposal job, cited where jobs are registered (src/server.js calls registerJobs)",
    files: ["src/server.js"],
    topic: /retention|dispos|delet|storage limitation|no longer than/i,
  },
];

/** Areas of the demo app that implement their control and must not be reported as violations. */
export const COMPLIANT_AREAS = [
  { id: "tls-enforced", files: ["src/middleware/https.js"] },
  { id: "access-control", files: ["src/middleware/auth.js", "src/routes/admin.js"] },
];

export type GoldenScore = {
  found: string[];
  missed: string[];
  /** Violation findings that match no planted violation. */
  unexpected: Finding[];
  /** Compliant areas wrongly reported as violations (a confirmed gap in that file does not count). */
  falselyFlagged: string[];
  /** Planted-only precision: share of violations that match a planted violation. */
  precision: number;
  recall: number;
  /** Confirmed gaps that at least one violation matched. */
  confirmedGaps: string[];
  /** Violations matching neither a planted violation nor a confirmed gap: the false positives. */
  unexplained: Finding[];
  /** Share of violations that match a planted violation or a confirmed gap. */
  precisionWithConfirmedGaps: number;
};

function matches(finding: Finding, planted: PlantedViolation): boolean {
  const citesFile = finding.evidence.some((e) => planted.files.includes(e.path));
  return citesFile && planted.topic.test(`${finding.obligation} ${finding.rationale}`);
}

export function scoreGolden(findings: Finding[]): GoldenScore {
  const violations = findings.filter((f) => f.status === "violation");
  const found = PLANTED_VIOLATIONS.filter((p) => violations.some((f) => matches(f, p))).map((p) => p.id);
  const missed = PLANTED_VIOLATIONS.filter((p) => !found.includes(p.id)).map((p) => p.id);
  const unexpected = violations.filter((f) => !PLANTED_VIOLATIONS.some((p) => matches(f, p)));
  const isConfirmedGap = (f: Finding) => CONFIRMED_GAPS.some((g) => matches(f, g));
  const falselyFlagged = COMPLIANT_AREAS.filter((area) =>
    violations.some(
      (f) => f.evidence.length > 0 && f.evidence.every((e) => area.files.includes(e.path)) && !isConfirmedGap(f),
    ),
  ).map((area) => area.id);
  const confirmedGaps = CONFIRMED_GAPS.filter((g) => unexpected.some((f) => matches(f, g))).map((g) => g.id);
  const unexplained = unexpected.filter((f) => !isConfirmedGap(f));

  return {
    found,
    missed,
    unexpected,
    falselyFlagged,
    confirmedGaps,
    unexplained,
    precisionWithConfirmedGaps: violations.length ? (violations.length - unexplained.length) / violations.length : 1,
    precision: violations.length ? (violations.length - unexpected.length) / violations.length : 1,
    recall: found.length / PLANTED_VIOLATIONS.length,
  };
}
