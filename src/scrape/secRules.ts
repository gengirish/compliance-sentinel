import { config } from "../config.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { buildSearchUrl, fetchFederalRegisterRules, type FederalRegisterOptions } from "./federalRegister.js";

/**
 * SEC rulemaking is published in the Federal Register, and the SEC's own RSS
 * page points there for it. EDGAR's Atom feed lists company filings (10-K, 8-K,
 * Form 4...), not rules, so this source is the Federal Register client with the
 * agency pinned to the SEC and its own search term.
 */
export const SEC_AGENCY = "securities-and-exchange-commission";

export const SEC_SOURCE: SourceDef = {
  name: "sec",
  kind: "api",
  url: `https://www.federalregister.gov/agencies/${SEC_AGENCY}`,
};

export type SecOptions = Omit<FederalRegisterOptions, "agencies">;

export function buildSecSearchUrl(opts: { term: string; perPage: number }): string {
  return buildSearchUrl({ term: opts.term, agencies: [SEC_AGENCY], perPage: opts.perPage });
}

/** Final rules issued by the SEC, newest first, with the regulatory text. */
export async function fetchSecRules(opts: SecOptions = {}): Promise<ScrapedRule[]> {
  return fetchFederalRegisterRules({
    fetchImpl: opts.fetchImpl,
    term: opts.term ?? config.SEC_TERM,
    perPage: opts.perPage ?? config.SEC_PER_PAGE,
    maxChars: opts.maxChars ?? config.SEC_MAX_CHARS,
    agencies: [SEC_AGENCY],
  });
}
