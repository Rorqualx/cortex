/**
 * Scrub-on-recall (QW4 part b, 2026-11-14 — memory-injection hardening).
 *
 * Narrow secret-shaped-string redaction for L3 facts read back into prompts.
 * Scope is deliberately tight: well-known token formats (sk-, ghp_, xox-,
 * AKIA, AIza), Bearer credentials, URL userinfo (user:pass@host), and
 * explicitly-labeled assignments (api_key=…, password: …). Anything else —
 * IPs, versions, dates, prose — passes through untouched. All patterns run
 * in linear time (character classes with bounded/measured repetition, no
 * nested quantifiers).
 *
 * Applied at the recall-rendering choke point (`formatMemorySection`) so
 * every prompt-facing memory packet is covered. Hits are logged for review;
 * over-broad scrubbing would mangle legitimate facts, so when in doubt a
 * pattern stays OUT of this list.
 */

// Credentialed URL userinfo: https://user:pass@host → https://***:***@host.
// Runs first so later label patterns never see raw userinfo.
const CREDENTIALED_URL_RE = /(\bhttps?:\/\/)[^\s/:@]+:[^\s/@]+@/g;

// Well-known token formats.
const TOKEN_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI-style
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub (ghp_/gho_/ghu_/ghs_/ghr_)
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,40}\b/g, // Google API key
];

// Bearer credential: keep the word, redact the credential itself.
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._-]{20,}/gi;

// Labeled assignment: `api_key = "…"`, `password: …`, `SECRET=…`.
// Value must be ≥12 chars of credential-shaped material to fire.
const LABELED_RE =
  /\b(api[_-]?key|secret|token|password|passwd|pwd)(\s*[:=]\s*)["']?[A-Za-z0-9._+/=-]{12,}["']?/gi;

/**
 * Redact secret-shaped substrings from `text`. Returns the scrubbed text;
 * the input is returned unchanged (same reference semantics not guaranteed)
 * when nothing matches. Pure, synchronous, no side effects.
 */
export function scrubSecrets(text: string): string {
  let out = String(text ?? "");
  out = out.replace(CREDENTIALED_URL_RE, "$1***:***@");
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  out = out.replace(BEARER_RE, "$1[REDACTED]");
  out = out.replace(LABELED_RE, "$1$2[REDACTED]");
  return out;
}

/** True when `text` contains at least one secret-shaped substring. */
export function hasSecretShape(text: string): boolean {
  return scrubSecrets(text) !== String(text ?? "");
}
