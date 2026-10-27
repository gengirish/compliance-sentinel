import type { Severity } from "./types.js";

/**
 * A small catalogue of technical controls. It drives the offline analyst (the
 * keyless fallback used in tests and dry runs) and seeds keyword search with
 * terms a model might not think to list.
 */
export type Control = {
  id: string;
  /** Matches regulation text that imposes this control. */
  ruleKeywords: RegExp;
  obligation: string;
  appliesTo: string;
  severity: Severity;
  /** Keywords used to pull candidate code. */
  searchTerms: string[];
  /** A line matching one of these is direct evidence of a violation. */
  violationPatterns: RegExp[];
  /** A line matching one of these is evidence that the control is implemented. */
  compliantPatterns: RegExp[];
  /**
   * When no line matches either list, the control is judged missing and the
   * finding points at the place it would normally live.
   */
  anchorPatterns?: RegExp[];
  /** Requirement ids this control maps to in common frameworks; used for evidence exports. */
  frameworkRefs?: string[];
};

const PII = String.raw`(?:ssn|social.?security|date.?of.?birth|dob|diagnosis|passport|full.?name|email|phone|password)`;

export const CONTROLS: Control[] = [
  {
    id: "pii-logging",
    ruleKeywords:
      /integrity and confidentiality|unauthori[sz]ed (?:or unlawful )?(?:processing|access|disclosure)|monitor and log|data minimi[sz]ation|limited to what is necessary/i,
    obligation:
      "Personal data must not be exposed in application logs; logging must be limited to what is necessary and protected against unauthorised access.",
    appliesTo: "Application code that logs request or record data",
    severity: "critical",
    searchTerms: ["console.log", "logger.info", "logger.debug", "ssn", "diagnosis", "dateOfBirth"],
    violationPatterns: [new RegExp(String.raw`(?:console\.(?:log|info|debug|warn)|logger\.\w+)\s*\(.*${PII}`, "i")],
    compliantPatterns: [/redact|maskPii|scrub(?:Pii)?\(|pino\(\{[^}]*redact/i],
  },
  {
    id: "data-retention",
    ruleKeywords:
      /no longer than is necessary|storage limitation|secure disposal|retention|erasure|dispos(?:e|al) of (?:customer|personal)/i,
    obligation:
      "Personal data must be deleted or anonymised once it is no longer needed; a retention schedule must be enforced by an automated disposal process.",
    appliesTo: "Data stores and scheduled jobs",
    severity: "high",
    searchTerms: ["retention", "purge", "deleteOlderThan", "anonymize", "expire", "setInterval", "cron", "registerJobs"],
    violationPatterns: [],
    compliantPatterns: [/retention|purge|deleteOlderThan|anonymi[sz]e|DELETE\s+FROM\s+\w+\s+WHERE\s+\w*(?:created|updated|last)\w*\s*</i],
    anchorPatterns: [/function\s+registerJobs|registerJobs\s*=|cron\.schedule|new\s+Queue\(/],
  },
  {
    id: "secrets-management",
    ruleKeywords:
      /encryption of personal data|protect by encryption|pseudonymisation and encryption|at rest|access controls|appropriate technical and organi[sz]ational measures/i,
    obligation:
      "Credentials and secrets must not be stored in plaintext in source code, and passwords must be hashed before storage.",
    appliesTo: "Configuration, credential handling and authentication code",
    severity: "critical",
    searchTerms: ["password", "secret", "apiKey", "token", "bcrypt", "argon2", "process.env"],
    violationPatterns: [
      /(?:password|passwd|secret|api_?key|token)\w*\s*[:=]\s*["'`][^"'`$]{6,}["'`]/i,
    ],
    compliantPatterns: [/bcrypt|argon2|scrypt|process\.env\.\w*(?:PASSWORD|SECRET|KEY|TOKEN)/],
  },
  {
    id: "consent-capture",
    ruleKeywords: /consent/i,
    obligation:
      "Where processing relies on consent, the system must capture an explicit opt-in and keep a record that demonstrates it; consent must not be assumed by default.",
    appliesTo: "Sign-up and marketing flows",
    severity: "high",
    searchTerms: ["consent", "marketing", "newsletter", "optIn", "subscribe", "signup"],
    violationPatterns: [
      /marketing\w*\s*(?:boolean\s+NOT\s+NULL\s+)?(?:DEFAULT|[:=])\s*true/i,
      /(?:VALUES|values)\s*\([^)]*\btrue\s*\)/,
      /now subscribed|subscribed to our/i,
    ],
    compliantPatterns: [/consent(?:ed|Given|At|_at|Record|Version)|opt_?in\s*(?:===|==|&&)|req\.body\.\w*consent/i],
  },
  {
    id: "breach-notification",
    ruleKeywords: /personal data breach|notification event|notify the (?:personal data breach|supervisory|Federal Trade Commission)|72 hours|30 days after discovery/i,
    obligation:
      "Security incidents affecting personal data must trigger notification of the regulator within the mandated deadline; the incident workflow must include a notification step.",
    appliesTo: "Incident handling code",
    severity: "critical",
    searchTerms: ["incident", "breach", "notify", "supervisory", "regulator", "security_incidents"],
    violationPatterns: [/\/\/\s*TODO.*(?:tell|notify|alert|report)/i],
    compliantPatterns: [/notify(?:Regulator|Authority|Supervisory|Dpo|Ftc)|breachNotification|sendBreach/i],
    anchorPatterns: [/security_incidents|incident/i],
  },
  {
    id: "encryption-in-transit",
    ruleKeywords: /in transit|transmitted|confidentiality, integrity, availability|encryption of personal data|protect by encryption/i,
    obligation: "Personal data must be encrypted in transit over external networks.",
    appliesTo: "Network-facing services",
    severity: "high",
    searchTerms: ["https", "hsts", "helmet", "tls", "ssl", "x-forwarded-proto"],
    violationPatterns: [/rejectUnauthorized\s*:\s*false/i],
    compliantPatterns: [/hsts\s*:|x-forwarded-proto|req\.secure|rejectUnauthorized\s*:\s*true/i],
  },
  {
    id: "access-control",
    ruleKeywords: /access controls|authori[sz]ed users|unauthori[sz]ed access|limit(?:ing)? access/i,
    obligation:
      "Access to personal data must be restricted to authenticated, authorised users under least privilege.",
    appliesTo: "API routes and administrative functions",
    severity: "high",
    searchTerms: ["requireAuth", "requireRole", "authorize", "jwt.verify", "role", "forbidden"],
    violationPatterns: [/app\.use\(\s*["'`]\/admin["'`]\s*,\s*require\(/],
    compliantPatterns: [/requireRole\(|jwt\.verify\(|status\(403\)/],
  },
  {
    id: "pci-pan-in-logs",
    ruleKeywords: /primary account number \(PAN\) is displayed|PAN is displayed or written out|masked so that at most/i,
    obligation:
      "Full card numbers (PAN) must never be written to logs; wherever a PAN is displayed or written out it must be masked to at most the first six and last four digits.",
    appliesTo: "Payment handling code and logging",
    severity: "critical",
    searchTerms: ["cardNumber", "card_number", "pan", "console.log", "logger"],
    violationPatterns: [/(?:console\.(?:log|info|debug|warn)|logger\.\w+)\s*\(.*\b(?:cardNumber|card_number|pan)\b/i],
    compliantPatterns: [/maskPan|last4|\.slice\(-4\)/i],
    frameworkRefs: ["PCI DSS 3.4.1", "PCI DSS 3.5.1"],
  },
  {
    id: "pci-sad-storage",
    ruleKeywords: /sensitive authentication data|card verification code/i,
    obligation:
      "Sensitive authentication data, including the card verification code (CVV), must not be stored after authorisation, even if it is encrypted.",
    appliesTo: "Payment handling code and the database schema",
    severity: "critical",
    searchTerms: ["cvv", "cvc", "card_verification", "INSERT INTO payments"],
    violationPatterns: [/^\s*cvv\s+(?:text|varchar|char)/i, /INSERT INTO payments[^"'`]*\bcvv\b/i],
    compliantPatterns: [/delete\s+\w+\.cvv|cvv\s*=\s*undefined/i],
    frameworkRefs: ["PCI DSS 3.3.1"],
  },
  {
    id: "pci-pan-protection",
    ruleKeywords: /rendered unreadable anywhere it is stored|index tokens|keyed cryptographic hash/i,
    obligation:
      "Stored card numbers (PAN) must be rendered unreadable by tokenisation, truncation, keyed one-way hashing or strong encryption.",
    appliesTo: "The database schema and code that stores card data",
    severity: "critical",
    searchTerms: ["card_number", "cardNumber", "token", "encrypt", "INSERT INTO payments"],
    violationPatterns: [/^\s*card_number\s+(?:text|varchar|char)/i],
    compliantPatterns: [/tokeni[sz]e\(|encryptPan|card_token/i],
    frameworkRefs: ["PCI DSS 3.5.1"],
  },
  {
    id: "pci-pan-transmission",
    ruleKeywords: /transmitted over open, public networks|Plain HTTP is never used/i,
    obligation:
      "Card numbers (PAN) must be protected with strong cryptography (TLS) whenever they are transmitted over open, public networks; plain HTTP must never carry account data.",
    appliesTo: "Outbound calls to payment processors and other services that receive card data",
    severity: "critical",
    searchTerms: ["http://", "fetch(", "axios", "PROCESSOR_URL", "cardNumber"],
    violationPatterns: [/["'`]http:\/\/(?!localhost|127\.0\.0\.1)[\w.-]+/i],
    compliantPatterns: [/["'`]https:\/\/[\w.-]+/i],
    frameworkRefs: ["PCI DSS 4.2.1"],
  },
  {
    id: "pci-shared-accounts",
    ruleKeywords: /shared or generic accounts|unique ID before/i,
    obligation:
      "Every user must have a unique ID; shared or generic accounts must not be used for administrative access.",
    appliesTo: "Authentication configuration and administrative access",
    severity: "high",
    searchTerms: ["username", "shared", "on-call", "opsConsole", "admin"],
    violationPatterns: [/one login for the whole|shared by the|username\s*:\s*["'`](?:ops|admin|root|shared|team)["'`]/i],
    compliantPatterns: [/req\.user\.id|userId/],
    frameworkRefs: ["PCI DSS 8.2.1", "PCI DSS 8.2.2"],
  },
];

export function controlsForText(text: string): Control[] {
  return CONTROLS.filter((control) => control.ruleKeywords.test(text));
}

export function controlById(id: string): Control | undefined {
  return CONTROLS.find((control) => control.id === id);
}
