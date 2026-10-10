import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root in dev (src/..) and in the built image (dist/..). */
export const ROOT_DIR = path.resolve(here, "..");

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
  RESEND_API_KEY: optional,
  ALERT_EMAIL_TO: optional,
  ALERT_EMAIL_FROM: z.string().default("Compliance Sentinel <alerts@resend.dev>"),
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
  PORT: z.coerce.number().int().default(8080),
  REPORTS_DIR: z.string().default("reports"),
  PGLITE_DIR: z.string().default(".data/pglite"),
  WEASYPRINT_BIN: z.string().default("weasyprint"),
  FEDREG_TERM: z.string().default("data security privacy safeguards"),
  FEDREG_AGENCIES: z.string().default("federal-trade-commission"),
  FEDREG_PER_PAGE: z.coerce.number().int().positive().max(50).default(5),
  FEDREG_MAX_CHARS: z.coerce.number().int().positive().default(120_000),
  EURLEX_CELEX: z.string().default("32016R0679"),
  SCRAPE_EURLEX: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}

export const config = loadConfig();

export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ROOT_DIR, p);
}

export function targetRepoPath(cfg: Config = config): string {
  return resolveFromRoot(cfg.TARGET_REPO_PATH ?? "demo-target-app");
}
