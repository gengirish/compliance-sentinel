// The eight scrapers from src/scrape/registry.ts, in catalog order, with a mix of states so the
// settings filters and sorts have something to tell apart. MAS stays off and on its default:
// the switch test in dashboard.spec.ts flips it and resets it.
const source = (name, label, region, description, state) => ({
  name,
  label,
  region,
  description,
  requires: state.requires ?? null,
  kind: "api",
  url: `https://example.com/${name}`,
  enabled: state.enabled,
  defaultEnabled: state.defaultEnabled ?? state.enabled,
  overridden: state.overridden ?? false,
  updatedAt: state.overridden ? "2026-10-20T09:00:00.000Z" : null,
  lastCheckedAt: state.lastCheckedAt ?? null,
  rules: state.rules ?? 0,
});

export const sources = [
  source("federal-register", "Federal Register", "US", "Final rules from US agencies matching the search term.", {
    enabled: true,
    rules: 12,
    lastCheckedAt: "2026-10-26T03:00:00.000Z",
  }),
  source("sec", "SEC", "US", "SEC final rules on cybersecurity and customer information.", {
    enabled: true,
    defaultEnabled: false,
    overridden: true,
    rules: 4,
    lastCheckedAt: "2026-10-25T03:00:00.000Z",
  }),
  source("finra", "FINRA", "US", "FINRA Regulatory Notices.", { enabled: false }),
  source("fca", "FCA", "UK", "Policy statements and finalised guidance from the FCA publications feed.", {
    enabled: true,
    rules: 7,
    lastCheckedAt: "2026-10-24T03:00:00.000Z",
  }),
  source("esma", "ESMA", "EU", "ESMA news items, optionally filtered by topic.", {
    enabled: false,
    defaultEnabled: true,
    overridden: true,
    rules: 3,
    lastCheckedAt: "2026-10-01T03:00:00.000Z",
  }),
  source("asic", "ASIC", "AU", "Regulatory guides from ASIC's regulatory tracker.", {
    enabled: false,
    requires: "pdftotext for the guide PDFs",
  }),
  // EUR-Lex really needs Chromium too; it is left out here so /needs Chromium/ names MAS alone.
  source("eur-lex", "EUR-Lex", "EU", "The consolidated text of an EU act.", {
    enabled: false,
    rules: 1,
    lastCheckedAt: "2026-09-15T03:00:00.000Z",
  }),
  source("mas", "MAS", "SG", "Circulars from the Monetary Authority of Singapore.", {
    enabled: false,
    requires: "Chromium (Playwright) and pdftotext",
  }),
];
