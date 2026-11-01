import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openMigratedDb } from "../src/db/client.js";
import { auditRuns, rules as rulesTable } from "../src/db/schema.js";
import type { NotifyInput } from "../src/graph/state.js";
import type { Analyst } from "../src/llm/analyst.js";
import { AnalystUnavailable, CircuitBreakerAnalyst, isTransientAnalystError } from "../src/llm/circuitBreaker.js";
import { OfflineAnalyst } from "../src/llm/offlineAnalyst.js";
import { AlertDeliveryError, notifyCritical } from "../src/notify/index.js";
import { runPipeline } from "../src/pipeline/run.js";
import { LocalHashEmbedder, VoyageEmbedder } from "../src/rag/embed.js";

const connectionError = () => new Anthropic.APIConnectionError({ message: "Connection error." });

/** The offline analyst with its relevance check replaced, standing in for a failing Claude. */
function analystWith(isRelevant: Analyst["isRelevant"]): Analyst {
  return new (class extends OfflineAnalyst {
    override isRelevant = isRelevant;
  })();
}

const voyageOk = () =>
  new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("Voyage embedder during an outage", () => {
  it("retries network errors and timeouts, not only HTTP statuses", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      if (calls === 2) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return voyageOk();
    }) as typeof fetch;
    const embedder = new VoyageEmbedder("key", "voyage-law-2", 64, fetchImpl, 4, 0);

    await expect(embedder.embed(["text"], "document")).resolves.toEqual([[1, 0]]);
    expect(calls).toBe(3);
  });

  it("gives up after its attempts with the network error", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const embedder = new VoyageEmbedder("key", "voyage-law-2", 64, fetchImpl, 3, 0);

    await expect(embedder.embed(["text"], "document")).rejects.toThrow(/unreachable: fetch failed/);
    expect(calls).toBe(3);
  });

  it("does not retry a 4xx that will not get better", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("bad key", { status: 401 });
    }) as typeof fetch;
    const embedder = new VoyageEmbedder("key", "voyage-law-2", 64, fetchImpl, 4, 0);

    await expect(embedder.embed(["text"], "document")).rejects.toThrow(/HTTP 401/);
    expect(calls).toBe(1);
  });
});

describe("model API circuit breaker", () => {
  it("classifies outages as transient and bad requests as not", () => {
    expect(isTransientAnalystError(connectionError())).toBe(true);
    expect(isTransientAnalystError(new Anthropic.APIConnectionTimeoutError())).toBe(true);
    expect(isTransientAnalystError(new Anthropic.InternalServerError(529, undefined, "overloaded", new Headers()))).toBe(true);
    expect(isTransientAnalystError(new Anthropic.RateLimitError(429, undefined, "slow down", new Headers()))).toBe(true);
    expect(isTransientAnalystError(new Anthropic.BadRequestError(400, undefined, "bad", new Headers()))).toBe(false);
    expect(isTransientAnalystError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientAnalystError(new Error("structured output unavailable"))).toBe(false);
  });

  it("opens after consecutive transient failures and then stops calling the API", async () => {
    let calls = 0;
    const inner = analystWith(async () => {
      calls++;
      throw connectionError();
    });
    const breaker = new CircuitBreakerAnalyst(inner, 3);
    const rule = {} as Parameters<Analyst["isRelevant"]>[0];

    await expect(breaker.isRelevant(rule, [])).rejects.toBeInstanceOf(Anthropic.APIConnectionError);
    await expect(breaker.isRelevant(rule, [])).rejects.toBeInstanceOf(Anthropic.APIConnectionError);
    await expect(breaker.isRelevant(rule, [])).rejects.toBeInstanceOf(AnalystUnavailable);
    expect(breaker.isOpen).toBe(true);
    await expect(breaker.isRelevant(rule, [])).rejects.toBeInstanceOf(AnalystUnavailable);
    expect(calls).toBe(3);
  });

  it("resets on success and ignores non-transient errors", async () => {
    const script: (() => unknown)[] = [
      () => { throw connectionError(); },
      () => { throw connectionError(); },
      () => ({ relevant: true, reason: "ok", costUsd: 0 }),
      () => { throw new Error("structured output unavailable"); },
      () => { throw connectionError(); },
      () => { throw connectionError(); },
    ];
    const inner = analystWith(async () => script.shift()!() as never);
    const breaker = new CircuitBreakerAnalyst(inner, 3);
    const rule = {} as Parameters<Analyst["isRelevant"]>[0];

    for (let i = 0; i < 6; i++) await breaker.isRelevant(rule, []).catch(() => undefined);
    expect(breaker.isOpen).toBe(false);
  });
});

describe("pipeline during an outage", () => {
  const ruleText = (n: number) => ({
    externalId: `R${n}`,
    title: `Rule ${n}`,
    effectiveDate: null,
    url: `https://example.test/r${n}`,
    rawText: `Article ${n}\nPersonal data must be encrypted at rest and access must be logged by the controller.`,
  });
  const deps = { renderReport: async () => ({ url: "memory://r", path: "memory://r" }), notify: async () => [] };

  it("fails the run when Claude is unreachable, so it is retried instead of reporting needs_review", async () => {
    const handle = await openMigratedDb({ pgliteDir: "memory" });
    try {
      const sources = [{ def: { name: "stub", kind: "api" as const, url: "https://example.test" }, fetch: async () => [1, 2, 3].map(ruleText) }];
      const down = analystWith(async () => {
        throw connectionError();
      });

      await expect(
        runPipeline({ trigger: "cron", handle, sources, analyst: down, embedder: new LocalHashEmbedder(), deps }),
      ).rejects.toBeInstanceOf(AnalystUnavailable);

      const [failed] = await handle.db.select().from(auditRuns);
      expect(failed!.status).toBe("failed");
      expect(failed!.error).toMatch(/model API unavailable/);
      const stored = await handle.db.select().from(rulesTable);
      expect(stored.every((r) => r.contentHash.startsWith("unaudited:"))).toBe(true);

      // Once the API is back, the same rules count as changed and are audited.
      const retry = await runPipeline({ trigger: "cron", handle, sources, analyst: new OfflineAnalyst(), embedder: new LocalHashEmbedder(), deps });
      expect(retry.status).toBe("completed");
      expect(retry.rulesInScope).toHaveLength(3);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("fails and records the run when every source is unreachable", async () => {
    const handle = await openMigratedDb({ pgliteDir: "memory" });
    try {
      const unreachable = (name: string) => ({
        def: { name, kind: "api" as const, url: `https://${name}.test` },
        fetch: async (): Promise<never> => {
          throw new TypeError("fetch failed");
        },
      });
      await expect(
        runPipeline({
          trigger: "cron",
          handle,
          sources: [unreachable("a"), unreachable("b")],
          analyst: new OfflineAnalyst(),
          embedder: new LocalHashEmbedder(),
          deps,
        }),
      ).rejects.toThrow(/every source failed/);

      const runs = await handle.db.select().from(auditRuns);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe("failed");
      expect(runs[0]!.error).toMatch(/a: fetch failed[\s\S]*b: fetch failed/);
    } finally {
      await handle.close();
    }
  });

  it("still audits when only some sources are unreachable", async () => {
    const handle = await openMigratedDb({ pgliteDir: "memory" });
    try {
      const sources = [
        { def: { name: "down", kind: "api" as const, url: "https://down.test" }, fetch: async (): Promise<never> => { throw new TypeError("fetch failed"); } },
        { def: { name: "up", kind: "api" as const, url: "https://up.test" }, fetch: async () => [ruleText(1)] },
      ];
      const result = await runPipeline({ trigger: "cron", handle, sources, analyst: new OfflineAnalyst(), embedder: new LocalHashEmbedder(), deps });
      expect(result.status).toBe("completed");
      const [run] = await handle.db.select().from(auditRuns).where(eq(auditRuns.id, result.runId));
      expect(run!.status).toBe("completed");
    } finally {
      await handle.close();
    }
  });
});

describe("alert delivery during an outage", () => {
  const input = {} as NotifyInput;

  it("retries a channel until it delivers", async () => {
    let slackCalls = 0;
    const delivered = await notifyCritical(input, {
      attempts: 3,
      backoffMs: 0,
      channels: [
        ["slack", async () => {
          slackCalls++;
          if (slackCalls < 3) throw new TypeError("fetch failed");
          return true;
        }],
        ["email", async () => true],
      ],
    });
    expect(delivered).toEqual(["slack", "email"]);
    expect(slackCalls).toBe(3);
  });

  it("reports the channels that still failed, keeping the ones that delivered", async () => {
    const attempt = notifyCritical(input, {
      attempts: 2,
      backoffMs: 0,
      channels: [
        ["slack", async () => { throw new TypeError("fetch failed"); }],
        ["email", async () => true],
      ],
    });
    await expect(attempt).rejects.toBeInstanceOf(AlertDeliveryError);
    const err = (await attempt.catch((e: unknown) => e)) as AlertDeliveryError;
    expect(err.delivered).toEqual(["email"]);
    expect(err.failed).toEqual([{ channel: "slack", error: "fetch failed" }]);
  });
});
