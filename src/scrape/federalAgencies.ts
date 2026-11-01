import { config } from "../config.js";
import type { ScrapedRule, SourceDef } from "./diff.js";
import { fetchFederalRegisterRules, type CfrPart, type FederalRegisterOptions } from "./federalRegister.js";

/**
 * More US rulemakers, each the Federal Register client pinned to its agencies, as the SEC source
 * is. The OCC, FDIC and Federal Reserve issue most of their rules jointly, so they share one
 * source rather than storing each interagency rule three times.
 */
export const CFPB_AGENCY = "consumer-financial-protection-bureau";
export const BANKING_AGENCIES = [
  "comptroller-of-the-currency",
  "federal-deposit-insurance-corporation",
  "federal-reserve-system",
];
/** HHS rulemaking is mostly Medicare and Medicaid; the HIPAA rules are the ones that amend 45 CFR 164. */
export const HIPAA_CFR: CfrPart = { title: 45, part: 164 };

export const CFPB_SOURCE: SourceDef = {
  name: "cfpb",
  kind: "api",
  url: `https://www.federalregister.gov/agencies/${CFPB_AGENCY}`,
};

export const BANKING_SOURCE: SourceDef = {
  name: "us-banking",
  kind: "api",
  url: "https://www.federalregister.gov/agencies/federal-reserve-system",
};

export const HIPAA_SOURCE: SourceDef = {
  name: "hipaa",
  kind: "api",
  url: "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164",
};

export type AgencyOptions = Omit<FederalRegisterOptions, "agencies" | "cfr">;

const shared = (opts: AgencyOptions) => ({
  fetchImpl: opts.fetchImpl,
  perPage: opts.perPage ?? config.FEDREG_PER_PAGE,
  maxChars: opts.maxChars ?? config.FEDREG_MAX_CHARS,
});

/** CFPB final rules, e.g. personal financial data rights (Section 1033) and Regulation P. */
export async function fetchCfpbRules(opts: AgencyOptions = {}): Promise<ScrapedRule[]> {
  return fetchFederalRegisterRules({ ...shared(opts), term: opts.term ?? config.CFPB_TERM, agencies: [CFPB_AGENCY] });
}

/** Final rules of the federal banking agencies, e.g. computer-security incident notification. */
export async function fetchBankingRules(opts: AgencyOptions = {}): Promise<ScrapedRule[]> {
  return fetchFederalRegisterRules({ ...shared(opts), term: opts.term ?? config.BANKING_TERM, agencies: BANKING_AGENCIES });
}

/** HHS final rules amending the HIPAA Privacy, Security and Breach Notification Rules. */
export async function fetchHipaaRules(opts: AgencyOptions = {}): Promise<ScrapedRule[]> {
  return fetchFederalRegisterRules({ ...shared(opts), term: opts.term ?? "", agencies: [], cfr: HIPAA_CFR });
}
