import { eq, sql } from "drizzle-orm";
import { config, type Config } from "../config.js";
import type { Db } from "../db/client.js";
import { sourceSettings } from "../db/schema.js";
import { ASIC_SOURCE, fetchAsicRules } from "./asicTracker.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { ESMA_SOURCE, fetchEsmaRules } from "./esmaNews.js";
import { EUR_LEX_SOURCE, scrapeEurLex } from "./eurLex.playwright.js";
import { FCA_SOURCE, fetchFcaRules } from "./fcaPublications.js";
import { FEDERAL_REGISTER_SOURCE, fetchFederalRegisterRules } from "./federalRegister.js";
import { fetchFinraRules, FINRA_SOURCE } from "./finraNotices.js";
import { MAS_SOURCE, scrapeMasCirculars } from "./masCirculars.playwright.js";
import { fetchSecRules, SEC_SOURCE } from "./secRules.js";

/**
 * Every live regulatory source, in the order they are scraped. Each can be switched on or off
 * from the dashboard; until it is, its SCRAPE_* flag decides. A disabled source is not fetched,
 * so its rules stop changing and are never brought into an audit. The bundled demo rules are
 * separate and unaffected.
 */
export type SourceEntry = {
  def: SourceDef;
  label: string;
  region: string;
  description: string;
  /** What the source needs beyond network access, shown next to its switch. */
  requires?: string;
  defaultEnabled: (cfg: Config) => boolean;
  fetch: () => Promise<ScrapedRule[]>;
};

export const SOURCE_CATALOG: SourceEntry[] = [
  {
    def: FEDERAL_REGISTER_SOURCE,
    label: "Federal Register",
    region: "US",
    description: "Final rules from US agencies (by default the FTC) matching the search term.",
    defaultEnabled: (cfg) => cfg.SCRAPE_FEDERAL_REGISTER,
    fetch: () => fetchFederalRegisterRules(),
  },
  {
    def: SEC_SOURCE,
    label: "SEC",
    region: "US",
    description: "SEC final rules on cybersecurity and customer information, via the Federal Register API.",
    defaultEnabled: (cfg) => cfg.SCRAPE_SEC,
    fetch: () => fetchSecRules(),
  },
  {
    def: FINRA_SOURCE,
    label: "FINRA",
    region: "US",
    description: "FINRA Regulatory Notices.",
    defaultEnabled: (cfg) => cfg.SCRAPE_FINRA,
    fetch: () => fetchFinraRules(),
  },
  {
    def: FCA_SOURCE,
    label: "FCA",
    region: "UK",
    description: "Policy statements, consultation papers and finalised guidance from the FCA publications feed.",
    defaultEnabled: (cfg) => cfg.SCRAPE_FCA,
    fetch: () => fetchFcaRules(),
  },
  {
    def: ESMA_SOURCE,
    label: "ESMA",
    region: "EU",
    description: "ESMA news items, optionally filtered by topic.",
    defaultEnabled: (cfg) => cfg.SCRAPE_ESMA,
    fetch: () => fetchEsmaRules(),
  },
  {
    def: ASIC_SOURCE,
    label: "ASIC",
    region: "AU",
    description: "Regulatory guides from ASIC's regulatory tracker, with the guide PDF when available.",
    requires: "pdftotext for the guide PDFs",
    defaultEnabled: (cfg) => cfg.SCRAPE_ASIC,
    fetch: () => fetchAsicRules(),
  },
  {
    def: EUR_LEX_SOURCE,
    label: "EUR-Lex",
    region: "EU",
    description: "The consolidated text of an EU act (by default the GDPR).",
    requires: "Chromium (Playwright)",
    defaultEnabled: (cfg) => cfg.SCRAPE_EURLEX,
    fetch: () => scrapeEurLex(),
  },
  {
    def: MAS_SOURCE,
    label: "MAS",
    region: "SG",
    description: "Circulars from the Monetary Authority of Singapore.",
    requires: "Chromium (Playwright) and pdftotext",
    defaultEnabled: (cfg) => cfg.SCRAPE_MAS,
    fetch: () => scrapeMasCirculars(),
  },
];

export type SourceState = {
  entry: SourceEntry;
  enabled: boolean;
  /** The SCRAPE_* flag's value, which applies again when the override is removed. */
  defaultEnabled: boolean;
  /** True when the dashboard has set this source, rather than the flag deciding. */
  overridden: boolean;
  updatedAt: Date | null;
};

export function findSource(name: string): SourceEntry | undefined {
  return SOURCE_CATALOG.find((s) => s.def.name === name);
}

/** Every catalog source with its effective switch. */
export async function sourceStates(db: Db, cfg: Config = config): Promise<SourceState[]> {
  const rows = await db.select().from(sourceSettings);
  const byName = new Map(rows.map((r) => [r.name, r]));
  return SOURCE_CATALOG.map((entry) => {
    const row = byName.get(entry.def.name);
    const defaultEnabled = entry.defaultEnabled(cfg);
    return { entry, enabled: row?.enabled ?? defaultEnabled, defaultEnabled, overridden: !!row, updatedAt: row?.updatedAt ?? null };
  });
}

/** The sources a scrape should fetch, read fresh each run. */
export async function enabledSources(db: Db, cfg: Config = config): Promise<SourceEntry[]> {
  return (await sourceStates(db, cfg)).filter((s) => s.enabled).map((s) => s.entry);
}

/** Switches a source on or off; `null` removes the override so its SCRAPE_* flag decides again. */
export async function setSourceEnabled(db: Db, name: string, enabled: boolean | null): Promise<void> {
  if (!findSource(name)) throw new Error(`unknown source "${name}"`);
  if (enabled === null) {
    await db.delete(sourceSettings).where(eq(sourceSettings.name, name));
    return;
  }
  await db
    .insert(sourceSettings)
    .values({ name, enabled })
    .onConflictDoUpdate({ target: sourceSettings.name, set: { enabled, updatedAt: sql`now()` } });
}
