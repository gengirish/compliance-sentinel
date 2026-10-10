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
  /** Compliant areas wrongly reported as violations. */
  falselyFlagged: string[];
  precision: number;
  recall: number;
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
  const falselyFlagged = COMPLIANT_AREAS.filter((area) =>
    violations.some((f) => f.evidence.length > 0 && f.evidence.every((e) => area.files.includes(e.path))),
  ).map((area) => area.id);

  return {
    found,
    missed,
    unexpected,
    falselyFlagged,
    precision: violations.length ? (violations.length - unexpected.length) / violations.length : 1,
    recall: found.length / PLANTED_VIOLATIONS.length,
  };
}
