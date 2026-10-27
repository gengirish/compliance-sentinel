/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely typed JSON responses */
import type { Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { tenants } from "../src/db/schema.js";
import { TENANT_HEADER } from "../src/db/tenants.js";
import { OfflineAnalyst } from "../src/llm/offlineAnalyst.js";
import { runPipeline } from "../src/pipeline/run.js";
import { LocalHashEmbedder } from "../src/rag/embed.js";
import type { AuditJobData } from "../src/queue/queue.js";
import { enabledSources, setSourceEnabled, SOURCE_CATALOG, sourceStates } from "../src/scrape/registry.js";
import { createApp } from "../src/web/server.js";

const auth = { authorization: "Bearer t" };

describe("source switches", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
  });
  afterAll(() => handle.close());
  afterEach(() => vi.restoreAllMocks());

  it("lists every scraper, defaulting to its SCRAPE_* flag", async () => {
    const cfg = loadConfig({ SCRAPE_MAS: "false", SCRAPE_SEC: "true", SCRAPE_FEDERAL_REGISTER: "0" });
    const states = await sourceStates(handle.db, cfg);
    expect(states.map((s) => s.entry.def.name)).toEqual(["federal-register", "sec", "finra", "fca", "esma", "asic", "eur-lex", "mas"]);
    const byName = Object.fromEntries(states.map((s) => [s.entry.def.name, s]));
    expect(byName["mas"]).toMatchObject({ enabled: false, defaultEnabled: false, overridden: false });
    expect(byName["sec"]).toMatchObject({ enabled: true, overridden: false });
    expect(byName["federal-register"]!.enabled).toBe(false);
  });

  it("lets a dashboard switch override the flag, and hands it back on reset", async () => {
    const cfg = loadConfig({ SCRAPE_MAS: "false" });
    await setSourceEnabled(handle.db, "mas", true);
    await setSourceEnabled(handle.db, "sec", false);
    let names = (await enabledSources(handle.db, cfg)).map((s) => s.def.name);
    expect(names).toContain("mas");
    expect(names).not.toContain("sec");

    await setSourceEnabled(handle.db, "mas", null);
    await setSourceEnabled(handle.db, "sec", null);
    names = (await enabledSources(handle.db, cfg)).map((s) => s.def.name);
    expect(names).not.toContain("mas");
    expect(names).toContain("sec");
    await expect(setSourceEnabled(handle.db, "nope", true)).rejects.toThrow(/unknown source/);
  });

  it("scrapes only the enabled sources on the next run", async () => {
    for (const s of SOURCE_CATALOG) await setSourceEnabled(handle.db, s.def.name, s.def.name === "finra");
    const fetches = SOURCE_CATALOG.map((s) => vi.spyOn(s, "fetch").mockResolvedValue([]));

    const result = await runPipeline({ trigger: "cron", handle, analyst: new OfflineAnalyst(), embedder: new LocalHashEmbedder() });

    expect(result.status).toBe("skipped");
    const called = SOURCE_CATALOG.filter((_, i) => fetches[i]!.mock.calls.length > 0).map((s) => s.def.name);
    expect(called).toEqual(["finra"]);
    for (const s of SOURCE_CATALOG) await setSourceEnabled(handle.db, s.def.name, null);
  });

  describe("API", () => {
    let app: ReturnType<typeof createApp>;
    beforeAll(async () => {
      app = createApp({ db: handle.db, getQueue: () => ({}) as Queue<AuditJobData>, token: "t" });
      await handle.db.insert(tenants).values({ name: "Acme", clerkOrgId: "org_acme" });
    });
    const put = (name: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request(`/settings/sources/${name}`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    it("lists the sources for the operator", async () => {
      const res = await app.request("/settings/sources", { headers: auth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any[];
      expect(body).toHaveLength(SOURCE_CATALOG.length);
      expect(body[0]).toMatchObject({ name: "federal-register", label: "Federal Register", region: "US", overridden: false, rules: 0 });
      expect(body.find((s) => s.name === "mas").requires).toMatch(/Chromium/);
    });

    it("switches a source and resets it", async () => {
      let res = await put("esma", { enabled: false });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ name: "esma", enabled: false, overridden: true });
      res = await put("esma", { enabled: null });
      expect(await res.json()).toMatchObject({ name: "esma", overridden: false });
    });

    it("rejects unknown sources, bad bodies, other tenants and missing tokens", async () => {
      expect((await put("nope", { enabled: true })).status).toBe(404);
      expect((await put("esma", { enabled: "yes" })).status).toBe(400);
      expect((await put("esma", { enabled: true, extra: 1 })).status).toBe(400);
      expect((await put("esma", { enabled: false }, { [TENANT_HEADER]: "org_acme" })).status).toBe(403);
      expect((await app.request("/settings/sources", { headers: { ...auth, [TENANT_HEADER]: "org_acme" } })).status).toBe(403);
      expect((await app.request("/settings/sources")).status).toBe(401);
    });
  });
});
