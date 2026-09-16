const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-[a-zA-Z0-9]{20,}/g, "[redacted-api-key]"],
  [/ghp_[a-zA-Z0-9]{36}/g, "[redacted-github-token]"],
  [/gho_[a-zA-Z0-9]{36}/g, "[redacted-github-token]"],
  [/ghs_[a-zA-Z0-9]{36}/g, "[redacted-github-token]"],
  [/AKIA[0-9A-Z]{16}/g, "[redacted-aws-key]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]"],
];

// Key-name-aware value redaction (security review fix 4): `api_key`/`apikey`/
// `password`/`passwd`/`token`/`secret`/`authorization` (case-insensitive)
// followed by a separator and a value — `key: value`, `key=value`, JSON
// `"key":"value"`, and the `X-API-Key:` / `Authorization: Bearer …` header
// forms. Quoted values only need 4+ chars (the quotes delimit precisely, and
// short passwords count); bare values need 16+ chars so prose like
// "token: something" is not over-redacted. The whole `key=value` span is
// replaced (like the prefix patterns), key included.
const KEY_VALUE_SECRET_RE =
  /(?<key>(?:x-)?api[_-]?key|apikey|password|passwd|token|secret|authorization)\s*['"]?\s*[=:]\s*['"]?\s*(?:"([^"\n]{4,})"|'([^'\n]{4,})'|([a-zA-Z0-9._\-+/]{16,}))/gi;
const BEARER_SECRET_RE = /authorization\s*:\s*bearer\s+[a-zA-Z0-9._\-+/=]{8,}/gi;

function keyLabel(key: string): string {
  const k = key.toLowerCase();
  if (k.includes("api")) return "api-key";
  if (k === "password" || k === "passwd") return "password";
  if (k === "token") return "token";
  if (k === "secret") return "secret";
  return "authorization";
}

function sensitiveKeyLabel(key: string): string | undefined {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  if (["apikey", "xapikey"].includes(normalized)) return "api-key";
  if (["password", "passwd"].includes(normalized)) return "password";
  if (["token", "accesstoken", "refreshtoken"].includes(normalized)) return "token";
  if (["secret", "clientsecret"].includes(normalized)) return "secret";
  if (normalized === "authorization") return "authorization";
  return undefined;
}

export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  result = result.replace(KEY_VALUE_SECRET_RE, (_m, key: string) => `[redacted-${keyLabel(key)}]`);
  result = result.replace(BEARER_SECRET_RE, "[redacted-authorization]");
  return result;
}

/** Recursively redact string values and object keys before persistence. */
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const label = sensitiveKeyLabel(key);
      result[redactSecrets(key)] = label ? `[redacted-${label}]` : redactDeep(child);
    }
    return result;
  }
  return value;
}
