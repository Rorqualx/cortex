/**
 * Protected-span matcher (F7, 2026-11-13): policy-bearing tool output must
 * survive context compression verbatim. When a tool result echoes safety
 * rules — workspace red lines, TOML exec policy, egress/vault rules — a
 * summarizing compressor can paraphrase or drop the exact literals (allowed
 * commands, hostnames, auth kinds) the agent is expected to follow. Such
 * messages are compression-exempt in `compressToolResults` and budget-exempt
 * in `enforceTokenBudget`.
 *
 * Matchers are deliberately narrow and literal (anchored sections, exact
 * config identifiers) so ordinary logs, diffs, and JSON arrays stay fully
 * compressible — an overly broad matcher here inflates every context.
 *
 * Patterns are anchored and linear-time (no nested quantifiers) — kept
 * ReDoS-safe per the skill-forge gate history.
 */

const PROTECTED_SPAN_PATTERNS: RegExp[] = [
  // Workspace "Red Lines" markdown section header (AGENTS.md/SOUL.md shape).
  /^#{1,6}[^\S\n]*red lines\b/im,
  // TOML policy sections: [exec_policy], [exec-policy], [secrets.egressProxy],
  // [egress_proxy], [vault], [vault.*]. Dotted keys allowed inside brackets.
  /^\[[^\]\n]*(?:exec[\s_-]*policy|egress[\s_-]*proxy|vault)[^\]\n]*\][^\S\n]*$/im,
  // Exec-policy identifiers (TOML/JSON/YAML keys, diagnostics, prose naming
  // the policy itself).
  /\bexec[\s_-]?policy\b/i,
  /\bexecPolicy\b/,
  // Egress/vault rule identifiers (config keys and persisted columns).
  /\bsecrets\.egressProxy\b/,
  /\begressProxy\b/,
  /\begress[\s_-]*(?:allowlist|bypass)[\s_-]*hosts?\b/i,
  /\bvault(?:\.key|\.allowlist|_session)\b/,
  /\bauth_(?:kind|config_json)\b/,
];

/** True when `text` carries a policy span that must survive compression. */
export function hasProtectedSpan(text: string): boolean {
  if (!text) {
    return false;
  }
  for (const pattern of PROTECTED_SPAN_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}
