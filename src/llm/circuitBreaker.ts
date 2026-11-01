import Anthropic from "@anthropic-ai/sdk";
import { errorMessage, log } from "../log.js";
import type { Analyst } from "./analyst.js";

/**
 * Raised once the model API has failed for transient reasons several times in a
 * row. Nodes rethrow it instead of degrading to `needs_review`, so the run fails,
 * its rules stay unaudited, and the queue retries it later.
 */
export class AnalystUnavailable extends Error {
  constructor(
    message: string,
    readonly costUsd = 0,
  ) {
    super(message);
    this.name = "AnalystUnavailable";
  }
}

/** Network errors, timeouts, rate limits and 5xx (including 529 overloaded): an outage, not a bad request. */
export function isTransientAnalystError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) return err.status === 429 || (err.status !== undefined && err.status >= 500);
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true;
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"].includes(code);
  }
  return false;
}

/**
 * Wraps an analyst for one run. After `threshold` consecutive transient failures
 * the circuit opens: every later call throws `AnalystUnavailable` without touching
 * the network. A success in between resets the count. Non-transient errors
 * (refusals, unparseable output) pass through and do not count.
 */
export class CircuitBreakerAnalyst implements Analyst {
  private consecutiveFailures = 0;
  private openedBy: string | null = null;

  constructor(
    private readonly inner: Analyst,
    private readonly threshold = 3,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get isOpen(): boolean {
    return this.openedBy !== null;
  }

  isRelevant(...args: Parameters<Analyst["isRelevant"]>) {
    return this.call(() => this.inner.isRelevant(...args));
  }
  extractObligations(...args: Parameters<Analyst["extractObligations"]>) {
    return this.call(() => this.inner.extractObligations(...args));
  }
  assess(...args: Parameters<Analyst["assess"]>) {
    return this.call(() => this.inner.assess(...args));
  }
  digest(...args: Parameters<Analyst["digest"]>) {
    return this.call(() => this.inner.digest(...args));
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.openedBy !== null) throw new AnalystUnavailable(`model API unavailable: ${this.openedBy}`);
    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      if (!isTransientAnalystError(err)) throw err;
      this.consecutiveFailures++;
      if (this.consecutiveFailures < this.threshold) throw err;
      this.openedBy = `${this.consecutiveFailures} consecutive failures, last: ${errorMessage(err)}`;
      log.error("model API circuit opened; failing the run so it is retried", { reason: this.openedBy });
      const costUsd = err && typeof err === "object" && "costUsd" in err ? Number(err.costUsd) || 0 : 0;
      throw new AnalystUnavailable(`model API unavailable: ${this.openedBy}`, costUsd);
    }
  }
}
