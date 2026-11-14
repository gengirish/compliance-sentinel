import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root in dev (src/..) and in the built image (dist/..). */
export const ROOT_DIR = path.resolve(here, "..");

/** "true"/"false"/"0" style switches. */
const flag = (def: "true" | "false") =>
  z
    .string()
    .default(def)
    .transform((v) => v !== "false" && v !== "0");

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: optional,
  REDIS_URL: optional,
  ANTHROPIC_API_KEY: optional,
  VOYAGE_API_KEY: optional,
  SLACK_WEBHOOK_URL: optional,
  /** AgentMail: the app's own inbox. Alerts are sent from it; mail sent to it arrives through the signed webhook. */
  AGENTMAIL_API_KEY: optional,
  AGENTMAIL_INBOX_ID: optional,
  AGENTMAIL_WEBHOOK_SECRET: optional,
  AGENTMAIL_API_URL: z.string().default("https://api.agentmail.to/v0"),
  /** Comma-separated alert recipients; they are also the senders allowed to ask the inbox for an audit. */
  ALERT_EMAIL_TO: optional,
  TIGRIS_BUCKET: optional,
  TIGRIS_ACCESS_KEY_ID: optional,
  TIGRIS_SECRET_ACCESS_KEY: optional,
  TIGRIS_ENDPOINT: z.string().default("https://fly.storage.tigris.dev"),
  TARGET_REPO_PATH: optional,
  TARGET_REPO_URL: optional,
  /** Comma-separated prefixes of fixture file names (e.g. "pci,gdpr") limiting which bundled rules --demo audits. */
  DEMO_RULES: optional,
  /** Indexing stops with an error past these caps, so a large repository fails fast instead of running up cost. */
  INDEX_MAX_FILES: z.coerce.number().int().positive().default(2_000),
  INDEX_MAX_BYTES: z.coerce.number().int().positive().default(8_000_000),
  /** GitHub App (ROADMAP §2b). Without an id and a key, repositories can only be audited by path or public URL. */
  GITHUB_APP_ID: optional,
  GITHUB_APP_SLUG: optional,
  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  GITHUB_WEBHOOK_SECRET: optional,
  /** The App's PEM key inline (newlines may be written as \n, as Fly secrets need), or a path to the .pem file. */
  GITHUB_APP_PRIVATE_KEY: optional,
  GITHUB_APP_PRIVATE_KEY_PATH: optional,
  GITHUB_API_URL: z.string().default("https://api.github.com"),
  /** Repositories are cloned from `<GITHUB_URL>/<owner>/<name>.git`. */
  GITHUB_URL: z.string().default("https://github.com"),
  RUN_TRIGGER_TOKEN: optional,
  PUBLIC_BASE_URL: optional,
  AUDIT_CRON: z.string().default("0 6 * * *"),
  /** The weekly "what changed" digest: Monday 07:00 UTC, covering the last DIGEST_DAYS days. */
  DIGEST_CRON: z.string().default("0 7 * * 1"),
  DIGEST_DAYS: z.coerce.number().int().positive().default(7),
  /** The dashboard's public URL: subscription emails link to its confirm and unsubscribe pages. */
  DASHBOARD_URL: z.string().default("https://compliance-sentinel-web.vercel.app"),
  MAX_RUN_COST_USD: z.coerce.number().positive().default(2),
  AUDIT_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** Per-request timeout and SDK retries for the Claude API; well under RUN_TIMEOUT_MINUTES. */
  ANTHROPIC_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  ANTHROPIC_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  /** Consecutive network, 429 or 5xx failures after which a run stops calling Claude and fails, to be retried. */
  ANALYST_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  /** Attempts per alert channel before the failure is recorded on the run. */
  ALERT_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /** A run still "running" after this long is presumed orphaned and marked failed. */
  RUN_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  /**
   * How often the worker re-checks for orphaned runs, after the sweep it does at startup.
   * Keep this above Neon's 5-minute idle timeout: a shorter timer keeps the database awake
   * around the clock. 0 disables the timer and keeps only the startup sweep.
   */
  STALE_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().nonnegative().default(60),
  PORT: z.coerce.number().int().default(8080),
  REPORTS_DIR: z.string().default("reports"),
  PGLITE_DIR: z.string().default(".data/pglite"),
  WEASYPRINT_BIN: z.string().default("weasyprint"),
  /**
   * SCRAPE_* flags are the defaults; the dashboard's Settings page overrides them per source
   * (the source_settings table), without a restart.
   */
  SCRAPE_FEDERAL_REGISTER: flag("true"),
  FEDREG_TERM: z.string().default("data security privacy safeguards"),
  FEDREG_AGENCIES: z.string().default("federal-trade-commission"),
  FEDREG_PER_PAGE: z.coerce.number().int().positive().max(50).default(5),
  FEDREG_MAX_CHARS: z.coerce.number().int().positive().default(120_000),
  /** EU acts to collect, by CELEX number: GDPR, DORA, NIS2, the AI Act and MiCA. */
  EURLEX_CELEX: z.string().default("32016R0679,32022R2554,32022L2555,32024R1689,32023R1114"),
  SCRAPE_EURLEX: flag("true"),
  /** SEC final rules, from the Federal Register API filtered to the SEC (EDGAR holds company filings, not rulemaking). */
  SEC_TERM: z.string().default("cybersecurity customer information safeguards"),
  SEC_PER_PAGE: z.coerce.number().int().positive().max(50).default(5),
  SEC_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  SCRAPE_SEC: flag("true"),
  /** More Federal Register agencies; each uses FEDREG_PER_PAGE and FEDREG_MAX_CHARS. */
  CFPB_TERM: z.string().default("privacy data security"),
  SCRAPE_CFPB: flag("true"),
  /** The OCC, FDIC and Federal Reserve, searched together; quotes make it an exact phrase. */
  BANKING_TERM: z.string().default("\"information security\""),
  SCRAPE_BANKING: flag("true"),
  /** HIPAA rules: HHS final rules amending 45 CFR Part 164. */
  SCRAPE_HIPAA: flag("true"),
  /** FCA publication types to keep from the publications RSS feed, comma-separated; plural and case do not matter. */
  FCA_TYPES: z.string().default("Policy statements,Consultation papers,Finalised guidance,Multi-firm reviews"),
  FCA_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  FCA_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  SCRAPE_FCA: flag("true"),
  /** MAS circulars need Chromium and pdftotext (poppler-utils), so they are off unless asked for. */
  MAS_MAX_ITEMS: z.coerce.number().int().positive().default(5),
  MAS_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  PDFTOTEXT_BIN: z.string().default("pdftotext"),
  SCRAPE_MAS: flag("false"),
  /** ESMA news topics to keep (comma-separated, as the site files them). Empty: everything. */
  ESMA_TOPICS: z.string().default(""),
  ESMA_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  ESMA_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  SCRAPE_ESMA: flag("true"),
  /** FINRA notice kinds to keep, by title prefix. */
  FINRA_TYPES: z.string().default("Regulatory Notice"),
  FINRA_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  FINRA_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  SCRAPE_FINRA: flag("true"),
  /** ASIC regulatory tracker year to read; unset: the current year. */
  ASIC_YEAR: optional,
  ASIC_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  /** Regulatory guides run to a hundred pages; keep more than for a news item. */
  ASIC_MAX_CHARS: z.coerce.number().int().positive().default(120_000),
  /** Convert the guide's PDF with pdftotext (poppler-utils); off keeps only the guide page text. */
  ASIC_INCLUDE_PDF: flag("true"),
  SCRAPE_ASIC: flag("true"),
  /** EDPB guidelines, recommendations and opinions on applying the GDPR. */
  EDPB_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  EDPB_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  /** Convert document PDFs with pdftotext; off keeps only the page text. */
  EDPB_INCLUDE_PDF: flag("true"),
  SCRAPE_EDPB: flag("true"),
  /** EBA guidelines and publications (outsourcing, ICT and security risk, AML). */
  EBA_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  EBA_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  /** Convert document PDFs with pdftotext; off keeps only the page text. */
  EBA_INCLUDE_PDF: flag("true"),
  SCRAPE_EBA: flag("true"),
  /** Bank of England Prudential Regulation Authority publications (operational resilience, outsourcing). */
  PRA_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  PRA_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  /** Convert document PDFs with pdftotext; off keeps only the page text. */
  PRA_INCLUDE_PDF: flag("true"),
  SCRAPE_PRA: flag("true"),
  /** NIST cybersecurity and privacy publications (CSF, SP 800 series). */
  NIST_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  NIST_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  /** Convert document PDFs with pdftotext; off keeps only the page text. */
  NIST_INCLUDE_PDF: flag("true"),
  SCRAPE_NIST: flag("true"),
  /** CISA directives and advisories. */
  CISA_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  CISA_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  SCRAPE_CISA: flag("true"),
  /** APRA prudential standards and guidance (CPS 234, CPS 230). */
  APRA_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  APRA_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  /** Convert document PDFs with pdftotext; off keeps only the page text. */
  APRA_INCLUDE_PDF: flag("true"),
  SCRAPE_APRA: flag("true"),
  /** OSFI guidelines (B-10 third-party risk, B-13 technology and cyber risk). */
  OSFI_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  OSFI_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  SCRAPE_OSFI: flag("true"),
  /** HKMA circulars and guidelines. */
  HKMA_MAX_ITEMS: z.coerce.number().int().positive().default(10),
  HKMA_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  /** Convert document PDFs with pdftotext; off keeps only the page text. */
  HKMA_INCLUDE_PDF: flag("true"),
  SCRAPE_HKMA: flag("true"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `fly storage create` sets BUCKET_NAME and AWS_* secrets; accept them when TIGRIS_* are unset.
  return EnvSchema.parse({
    ...env,
    TIGRIS_BUCKET: env.TIGRIS_BUCKET || env.BUCKET_NAME,
    TIGRIS_ACCESS_KEY_ID: env.TIGRIS_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID,
    TIGRIS_SECRET_ACCESS_KEY: env.TIGRIS_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY,
    TIGRIS_ENDPOINT: env.TIGRIS_ENDPOINT || env.AWS_ENDPOINT_URL_S3,
  });
}

export const config = loadConfig();

export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ROOT_DIR, p);
}

export function targetRepoPath(cfg: Config = config): string {
  return resolveFromRoot(cfg.TARGET_REPO_PATH ?? "demo-target-app");
}
