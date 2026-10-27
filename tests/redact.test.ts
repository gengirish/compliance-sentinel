import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  it("masks the demo repo's hard-coded credentials but keeps the keys and line count", () => {
    const text = readFileSync(new URL("../demo-target-app/src/config.js", import.meta.url), "utf8");
    const out = redactSecrets(text, "src/config.js");
    expect(out).not.toContain("Winter2024!portal");
    expect(out).not.toContain("acme-portal-jwt-signing-secret");
    expect(out).not.toContain("mailer-live-key-9f2c41d07a");
    expect(out).toContain(`password: "${REDACTED}"`);
    expect(out).toContain(`jwtSecret: "${REDACTED}"`);
    // References to the environment are not secrets, and the analyst needs to see them.
    expect(out).toContain("password: process.env.OPS_CONSOLE_PASSWORD");
    expect(out.split("\n")).toHaveLength(text.split("\n").length);
  });

  it("masks quoted values in JSON and Python, but not references or ordinary keys", () => {
    expect(redactSecrets(`{"api_key": "abc123xyz"}`)).toBe(`{"api_key": "${REDACTED}"}`);
    expect(redactSecrets(`DB_PASSWORD = 'hunter22'`)).toBe(`DB_PASSWORD = '${REDACTED}'`);
    expect(redactSecrets("token: `${process.env.TOKEN}`")).toBe("token: `${process.env.TOKEN}`");
    expect(redactSecrets(`host: "db.internal"`)).toBe(`host: "db.internal"`);
  });

  it("masks unquoted values only in config files", () => {
    expect(redactSecrets("export AUTH_TOKEN=s3cr3t-value\nPORT=3000", ".env")).toBe(`export AUTH_TOKEN=${REDACTED}\nPORT=3000`);
    expect(redactSecrets("  password: hunter22 # prod", "deploy/values.yaml")).toBe(`  password: ${REDACTED} # prod`);
    expect(redactSecrets("password: ${DB_PASSWORD}", "compose.yml")).toBe("password: ${DB_PASSWORD}");
    expect(redactSecrets("const token = getToken();", "src/a.ts")).toBe("const token = getToken();");
  });

  it("masks known token formats, URL passwords and private keys anywhere", () => {
    expect(redactSecrets("const k = AKIAIOSFODNN7EXAMPLE;")).toBe(`const k = ${REDACTED};`);
    expect(redactSecrets("url = postgres://app:pa55word@db:5432/x")).toBe(`url = postgres://app:${REDACTED}@db:5432/x`);
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKC\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(pem);
    expect(out).not.toContain("MIIEow");
    expect(out.split("\n")).toHaveLength(4);
  });
});
