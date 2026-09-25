/**
 * Redact secrets from tool output before it reaches the transcript or the
 * model context. `.env` reads are already restricted by the permission
 * layer; this catches keys embedded in other files or printed by commands.
 */

const MASK = "[redacted]";

/** Common credential shapes found in source files and command output. */
const KEY_PATTERNS: RegExp[] = [
  /sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{8,}/g, // Anthropic / OpenAI / OpenRouter
  /gh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  new RegExp("-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----", "g"), // PEM blocks
];

/** Env vars whose values count as secrets (names containing KEY, TOKEN, SECRET, or PASSWORD). */
const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD)/i;

/** Minimum length for an env value to be worth masking (avoids false positives). */
const MIN_SECRET_LEN = 8;

function collectEnvSecrets(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LEN) continue;
    if (!SECRET_ENV_RE.test(name)) continue;
    out.push(value);
  }
  // Longest first so overlapping values mask correctly.
  return out.sort((a, b) => b.length - a.length);
}

/** Mask secret values and key-shaped tokens in `text`. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const secret of collectEnvSecrets(env)) {
    out = out.split(secret).join(MASK);
  }
  for (const re of KEY_PATTERNS) {
    out = out.replace(re, MASK);
  }
  return out;
}
