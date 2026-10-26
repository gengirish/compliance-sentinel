export const USER_AGENT = "compliance-sentinel/0.1 (+https://github.com/gengirish/compliance-sentinel)";

/**
 * GET with up to `attempts` tries and exponential backoff. Retries network
 * errors, 5xx and 429; any other 4xx will not get better and fails at once.
 */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  attempts = 3,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { "user-agent": USER_AGENT, ...init.headers },
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });
      if (res.ok) return res;
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status} for ${url}`);
      lastError = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      lastError = err;
      if (err instanceof Error && /^HTTP 4/.test(err.message)) throw err;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
  }
  throw lastError;
}
