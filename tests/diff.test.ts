import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMigratedDb, type DbHandle } from "../src/db/client.js";
import { rules } from "../src/db/schema.js";
import {
  contentHash,
  diffRules,
  normalizeRuleText,
  persistChanges,
  upsertSource,
  type ScrapedRule,
} from "../src/scrape/diff.js";

const rule = (externalId: string, rawText: string): ScrapedRule => ({
  externalId,
  title: `Rule ${externalId}`,
  effectiveDate: "2026-01-01",
  url: `https://example.test/${externalId}`,
  rawText,
});

describe("diffRules", () => {
  it("reports rules it has never seen as new", () => {
    const changes = diffRules([rule("A", "text a"), rule("B", "text b")], new Map());
    expect(changes.map((c) => [c.rule.externalId, c.kind])).toEqual([
      ["A", "new"],
      ["B", "new"],
    ]);
  });

  it("reports nothing when content is unchanged", () => {
    const known = new Map([["A", contentHash("text a")]]);
    expect(diffRules([rule("A", "text a")], known)).toEqual([]);
  });

  it("reports changed content as amended", () => {
    const known = new Map([["A", contentHash("text a")]]);
    const [change] = diffRules([rule("A", "text a, as amended")], known);
    expect(change?.kind).toBe("amended");
    expect(change?.contentHash).toBe(contentHash("text a, as amended"));
  });

  it("ignores whitespace-only differences", () => {
    const known = new Map([["A", contentHash("Article 1\nThe controller shall act.")]]);
    const reflowed = "Article 1  \r\n\r\n\r\n\r\nThe   controller shall act.  ";
    expect(normalizeRuleText(reflowed)).toBe("Article 1\n\nThe controller shall act.");
    expect(diffRules([rule("A", "Article 1 \r\nThe  controller shall act.\n")], known)).toEqual([]);
  });

  it("keeps the first copy when a source lists a rule twice", () => {
    const changes = diffRules([rule("A", "first"), rule("A", "second")], new Map());
    expect(changes).toHaveLength(1);
    expect(changes[0]?.rule.rawText).toBe("first");
  });
});

describe("persistChanges", () => {
  let handle: DbHandle;
  let sourceId: number;

  beforeAll(async () => {
    handle = await openMigratedDb({ pgliteDir: "memory" });
    sourceId = await upsertSource(handle.db, { name: "test-source", kind: "api", url: "https://example.test" });
  });
  afterAll(() => handle.close());

  it("stores new rules, then returns nothing on an identical second pass", async () => {
    const first = await persistChanges(handle.db, sourceId, [rule("A", "text a"), rule("B", "text b")]);
    expect(first.changed).toHaveLength(2);

    const second = await persistChanges(handle.db, sourceId, [rule("A", "text a"), rule("B", "text b")]);
    expect(second.changed).toHaveLength(0);
  });

  it("updates the stored row in place when a rule is amended", async () => {
    const result = await persistChanges(handle.db, sourceId, [rule("A", "text a, amended"), rule("B", "text b")]);
    expect(result.changes.map((c) => [c.rule.externalId, c.kind])).toEqual([["A", "amended"]]);

    const stored = await handle.db.select().from(rules);
    expect(stored).toHaveLength(2);
    expect(stored.find((r) => r.externalId === "A")?.rawText).toBe("text a, amended");
  });

  it("re-emits unchanged rules when forced", async () => {
    const result = await persistChanges(handle.db, sourceId, [rule("B", "text b")], { force: true });
    expect(result.changed.map((r) => r.externalId)).toEqual(["B"]);
  });

  it("upserts a source by name", async () => {
    const again = await upsertSource(handle.db, { name: "test-source", kind: "api", url: "https://example.test/v2" });
    expect(again).toBe(sourceId);
  });
});
