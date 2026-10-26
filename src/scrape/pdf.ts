import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const run = promisify(execFile);

/** Text of a PDF via poppler's pdftotext (the `PDFTOTEXT_BIN` binary), through a temp file. */
export async function pdfToText(pdf: Buffer, bin = config.PDFTOTEXT_BIN): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sentinel-pdf-"));
  const file = path.join(dir, "document.pdf");
  try {
    writeFileSync(file, pdf);
    const { stdout } = await run(bin, ["-nopgbrk", "-enc", "UTF-8", file, "-"], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    return stdout.replace(/[ \t]+\n/g, "\n").trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
