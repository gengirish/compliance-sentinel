/**
 * Masks credentials in scanned code before it is stored, sent to the model, shown or put in a
 * report. Only the value is replaced, so `password: "[REDACTED]"` still tells the analyst that a
 * literal was hard-coded there. Line breaks are never added or removed, so cited line numbers
 * stay valid.
 */
export const REDACTED = "[REDACTED]";

/** Key names that hold secrets: `password`, `db_pass`, `jwtSecret`, `apiKey`, `AUTH_TOKEN`... */
const SECRET_KEY = String.raw`[\w.-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credential)[\w.-]*`;

/** `key: "value"`, `"key": 'value'`, `key = \`value\`` in any language. */
const QUOTED_ASSIGNMENT = new RegExp(String.raw`(["']?${SECRET_KEY}["']?\s*[:=]\s*)(["'\`])([^"'\`\n]+)\2`, "gi");

/** `KEY=value` and `key: value` in env, YAML, TOML and INI files, where values are unquoted. */
const BARE_ASSIGNMENT = new RegExp(String.raw`^(\s*(?:export\s+)?${SECRET_KEY}\s*[:=][ \t]*)([^\s#"'\`][^\s#]*)`, "gim");
const BARE_VALUE_FILES = /(?:^|\/)\.env(?:\.[\w-]+)?$|\.(?:env|ya?ml|toml|ini|properties|cfg|conf)$/i;

/** Values that point at a secret rather than being one. */
const REFERENCE = /^(?:\$\{.*\}|\$[A-Z_][A-Z0-9_]*|process\.env\b|os\.environ|os\.getenv|null|none|true|false|changeme|<[^>]*>)$/i;

/** Credential formats that are secret wherever they appear. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, // Anthropic, OpenAI
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
];

/** The password in `scheme://user:password@host`. */
const URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:)([^\s@/'"`]+)(@)/gi;

const PRIVATE_KEY_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g;

/** `path` decides whether unquoted values count, as they do in config files but not in code. */
export function redactSecrets(text: string, path = ""): string {
  let out = text.replace(PRIVATE_KEY_BLOCK, (_m, begin: string, body: string, end: string) =>
    begin + body.split("\n").map((line, i, all) => (i === 0 || i === all.length - 1 ? line : REDACTED)).join("\n") + end,
  );
  out = out.replace(QUOTED_ASSIGNMENT, (match, prefix: string, quote: string, value: string) =>
    REFERENCE.test(value.trim()) ? match : `${prefix}${quote}${REDACTED}${quote}`,
  );
  if (BARE_VALUE_FILES.test(path)) {
    out = out.replace(BARE_ASSIGNMENT, (match, prefix: string, value: string) =>
      REFERENCE.test(value) || value === REDACTED ? match : prefix + REDACTED,
    );
  }
  out = out.replace(URL_CREDENTIAL, (_m, head: string, _password: string, at: string) => head + REDACTED + at);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}
