import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoNameFromUrl } from "../src/pipeline/run.js";
import { assertIndexable, listRepoFiles, RepoTooLargeError } from "../src/rag/indexRepo.js";

describe("repoNameFromUrl", () => {
  it("reads owner/name from GitHub https and ssh URLs", () => {
    expect(repoNameFromUrl("https://github.com/ghostfolio/ghostfolio")).toBe("ghostfolio/ghostfolio");
    expect(repoNameFromUrl("https://github.com/juice-shop/juice-shop.git")).toBe("juice-shop/juice-shop");
    expect(repoNameFromUrl("git@github.com:maybe-finance/maybe.git")).toBe("maybe-finance/maybe");
  });
});

describe("listRepoFiles", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sentinel-repo-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  write("src/app.ts", "export const x = 1;\n");
  write("src/i18n/de.json", '{"hello":"hallo"}');
  write("public/vendor.min.js", "var a=1;");
  write("src/types.d.ts", "declare const y: number;");
  write("yarn.lock", "lock");
  write("db/schema.sql", "create table t (id int);");

  it("keeps source files and skips translations, minified bundles, declarations and lockfiles", () => {
    expect(listRepoFiles(root).map((f) => f.path)).toEqual(["db/schema.sql", "src/app.ts"]);
  });
});

describe("assertIndexable", () => {
  const files = [
    { path: "a.ts", text: "x".repeat(600) },
    { path: "b.ts", text: "y".repeat(600) },
  ];

  it("passes under both caps", () => {
    expect(() => assertIndexable(files, { maxFiles: 2, maxBytes: 1_200 })).not.toThrow();
  });

  it("fails fast past the file cap or the byte cap", () => {
    expect(() => assertIndexable(files, { maxFiles: 1, maxBytes: 10_000 })).toThrow(RepoTooLargeError);
    expect(() => assertIndexable(files, { maxFiles: 10, maxBytes: 1_000 })).toThrow(/too large to index: 2 files, 1200 bytes/);
  });
});
