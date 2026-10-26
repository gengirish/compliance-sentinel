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
  RUN_TRIGGER_TOKEN: optional,
  PUBLIC_BASE_URL: optional,
  AUDIT_CRON: z.string().default("0 6 * * *"),
  MAX_RUN_COST_USD: z.coerce.number().positive().default(2),
  AUDIT_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** A run still "running" after this long is presumed orphaned and marked failed. */
  RUN_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  PORT: z.coerce.number().int().default(8080),
  REPORTS_DIR: z.string().default("reports"),
  PGLITE_DIR: z.string().default(".data/pglite"),
  WEASYPRINT_BIN: z.string().default("weasyprint"),
  FEDREG_TERM: z.string().default("data security privacy safeguards"),
  FEDREG_AGENCIES: z.string().default("federal-trade-commission"),
  FEDREG_PER_PAGE: z.coerce.number().int().positive().max(50).default(5),
  FEDREG_MAX_CHARS: z.coerce.number().int().positive().default(120_000),
  EURLEX_CELEX: z.string().default("32016R0679"),
  SCRAPE_EURLEX: flag("true"),
  /** SEC final rules, from the Federal Register API filtered to the SEC (EDGAR holds company filings, not rulemaking). */
  SEC_TERM: z.string().default("cybersecurity customer information safeguards"),
  SEC_PER_PAGE: z.coerce.number().int().positive().max(50).default(5),
  SEC_MAX_CHARS: z.coerce.number().int().positive().default(80_000),
  SCRAPE_SEC: flag("true"),
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
