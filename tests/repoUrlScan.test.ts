import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ROOT_DIR } from "../src/config.js";
import { openMigratedDb } from "../src/db/client.js";
import { OfflineAnalyst } from "../src/llm/offlineAnalyst.js";
import { notifyCritical } from "../src/notify/index.js";
import { runPipeline } from "../src/pipeline/run.js";
import { LocalHashEmbedder } from "../src/rag/embed.js";

vi.mock("../src/notify/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/notify/index.js")>()),
  notifyCritical: vi.fn(async () => ["slack", "email"]),
}));

describe("an audit of a repository URL", () => {
  // A local git repo stands in for a public one: cloneRepo fetches from a path the same way.
  const origin = mkdtempSync(path.join(tmpdir(), "sentinel-origin-"));
  afterAll(() => rmSync(origin, { recursive: true, force: true }));
  cpSync(path.join(ROOT_DIR, "demo-target-app"), origin, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", origin, ...args], { stdio: "ignore" });
  git("init", "--quiet");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init");

  it("finds the critical violations but sends no alerts", async () => {
    const handle = await openMigratedDb({ pgliteDir: "memory" });
    try {
      const result = await runPipeline({
        trigger: "manual",
        demo: true,
        repoUrl: origin,
        handle,
        analyst: new OfflineAnalyst(),
        embedder: new LocalHashEmbedder(),
        deps: { renderReport: async (state) => ({ url: `memory://run-${state.runId}`, path: `memory://run-${state.runId}` }) },
      });
      expect(result.status).toBe("completed");
      expect(result.summary?.hasCritical).toBe(true);
      expect(notifyCritical).not.toHaveBeenCalled();
      expect(result.notified).toEqual([]);
    } finally {
      await handle.close();
    }
  }, 120_000);
});
