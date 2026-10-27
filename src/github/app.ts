import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { config, resolveFromRoot } from "../config.js";

/**
 * The GitHub App's own credentials: a short-lived JWT signed with the App's key buys
 * installation tokens, and those clone repositories and call the API for one installation.
 * No SDK, so the dependency list stays the same. Tokens live only in memory: they are
 * never written to the database, to logs or into a clone's .git/config.
 */

/** An RS256 JWT for the App, valid for 9 minutes (GitHub allows 10) and backdated a minute for clock drift. */
export function appJwt(appId: string, privateKey: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

/** Checks `x-hub-signature-256` ("sha256=<hex>") against the raw request body. */
export function verifyGitHubSignature(raw: string, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const want = createHmac("sha256", secret).update(raw).digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

const TokenResponse = z.object({ token: z.string(), expires_at: z.string() });
const RepoResponse = z.object({ id: z.number(), full_name: z.string(), default_branch: z.string() });
export type GitHubRepoInfo = z.infer<typeof RepoResponse>;

/** Refresh a cached installation token this long before GitHub expires it (tokens last an hour). */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

export type GitHubAppOptions = {
  appId: string;
  privateKey: string;
  apiUrl?: string;
  /** Where repositories are cloned from: `<gitUrl>/<owner>/<name>.git`. */
  gitUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export class GitHubApp {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly apiUrl: string;
  private readonly gitUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(opts: GitHubAppOptions) {
    this.appId = opts.appId;
    this.privateKey = opts.privateKey;
    this.apiUrl = (opts.apiUrl ?? config.GITHUB_API_URL).replace(/\/+$/, "");
    this.gitUrl = (opts.gitUrl ?? config.GITHUB_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** The configured App, or null when GITHUB_APP_ID or its private key is not set. */
  static fromConfig(overrides: Partial<GitHubAppOptions> = {}): GitHubApp | null {
    const appId = overrides.appId ?? config.GITHUB_APP_ID;
    const privateKey = overrides.privateKey ?? loadPrivateKey();
    if (!appId || !privateKey) return null;
    return new GitHubApp({ ...overrides, appId, privateKey });
  }

  cloneUrl(fullName: string): string {
    return `${this.gitUrl}/${fullName}.git`;
  }

  /** A token for one installation, reused until shortly before it expires. */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.now()) return cached.token;
    const res = await this.call(`/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      bearer: appJwt(this.appId, this.privateKey, this.now()),
    });
    const { token, expires_at } = TokenResponse.parse(res);
    this.tokens.set(installationId, { token, expiresAt: Date.parse(expires_at) });
    return token;
  }

  /** A REST call made as the installation. */
  async request(installationId: number, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    return this.call(path, { ...init, bearer: await this.installationToken(installationId) });
  }

  async getRepo(installationId: number, fullName: string): Promise<GitHubRepoInfo> {
    return RepoResponse.parse(await this.request(installationId, `/repos/${fullName}`));
  }

  private async call(path: string, init: { method?: string; body?: unknown; bearer: string }): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${init.bearer}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "compliance-sentinel",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    // The body of an error is GitHub's message, never the token we sent.
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status} for ${init.method ?? "GET"} ${path}: ${(await res.text()).slice(0, 500)}`);
    return res.status === 204 ? null : res.json();
  }
}

/** GITHUB_APP_PRIVATE_KEY (inline) wins over GITHUB_APP_PRIVATE_KEY_PATH. */
export function loadPrivateKey(cfg = config): string | undefined {
  if (cfg.GITHUB_APP_PRIVATE_KEY) return cfg.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  if (cfg.GITHUB_APP_PRIVATE_KEY_PATH) return readFileSync(resolveFromRoot(cfg.GITHUB_APP_PRIVATE_KEY_PATH), "utf8");
  return undefined;
}
