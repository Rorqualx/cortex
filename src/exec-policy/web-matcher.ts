/**
 * Web egress matcher — evaluates a URL against the optional `[web]` section of
 * the exec policy. Reuses the exec-policy config file/loader; the matching model
 * is host-glob (not the shell prefix-token matcher), since web tools carry a URL,
 * not a tokenized command line.
 */
import type { ExecPolicy } from "./types.js";

export type WebPolicyDecision = "allow" | "forbidden";

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Glob host match:
 * - "*" matches any host.
 * - "*.example.com" matches "a.example.com" and the bare apex "example.com".
 * - other "*" patterns match as wildcards over the host string.
 * - otherwise an exact host match.
 */
function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) {
    return false;
  }
  if (p === "*" || p === host) {
    return true;
  }
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  if (p.includes("*")) {
    const re = new RegExp(`^${p.split("*").map(escapeRegExp).join(".*")}$`);
    return re.test(host);
  }
  return false;
}

/**
 * Decide whether `url` may be fetched under `policy`.
 *
 * - No `web` section → "allow" (unchanged behavior for existing users).
 * - Deny wins over allow.
 * - When an allowlist is configured, the host must match it; otherwise only the
 *   denylist applies.
 * - An unparseable URL is forbidden when any web policy is configured.
 */
export function evaluateWebPolicy(url: string, policy: ExecPolicy): WebPolicyDecision {
  const web = policy.web;
  if (!web) {
    return "allow";
  }

  const host = hostFromUrl(url);
  if (!host) {
    return "forbidden";
  }

  if (web.deny.some((pattern) => hostMatches(host, pattern))) {
    return "forbidden";
  }
  if (web.allow.length > 0) {
    return web.allow.some((pattern) => hostMatches(host, pattern)) ? "allow" : "forbidden";
  }
  return "allow";
}
