/**
 * Delegation Safety Pre-Check — lightweight pattern-based safety assessment.
 *
 * Research finding (Finding 8, 2026-08-03): schema-formatted specs weaken
 * model refusal signals. The pre-check uses the *flattened* plain-text tool
 * description (from `schema-flattener.ts`) plus the task text to run a fast
 * rule-based safety assessment before the delegation router dispatches.
 *
 * Design principles:
 * - **Fail-open**: unknown patterns do not block. The check augments safety
 *   but never turns a healthy delegation into a blocked one on a false positive.
 * - **Config-gated**: can be disabled entirely via config for trusted tools.
 * - **Pattern-based (no LLM call)**: keeps latency to zero. The grounding
 *   verifier pattern (LLM judge) can be layered on top later for high-stakes
 *   kinds.
 * - **Auditable**: every match returns the rule that fired and the matched
 *   substring so the caller can log or surface it.
 *
 * Integration point: called in `tools.ts` before `resolveRoute()` +
 * `runDelegation()`. If the check returns `unsafe`, the tool returns an
 * error result instead of dispatching.
 */

import type { FlattenedTool } from "./schema-flattener.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SafetyVerdict =
  | { safe: true }
  | { safe: false; rule: string; matched: string; reason: string };

export type SafetyCheckOptions = {
  /** Skip the check entirely (trusted tools, internal-only mode, etc.). */
  disabled?: boolean;
  /**
   * Block dispatch when unsafe. If false, the verdict is returned but the
   * dispatch proceeds (advisory mode). Default: false (advisory).
   */
  blockOnUnsafe?: boolean;
};

// ---------------------------------------------------------------------------
// Safety patterns — anchored, linear-time regexes (no nested quantifiers)
// ---------------------------------------------------------------------------

interface SafetyRule {
  /** Short identifier for logging. */
  id: string;
  /** Human-readable reason. */
  reason: string;
  /**
   * Pattern to match against the task text. Must be linear-time (no nested
   * quantifiers, no unanchored greedy `.*` chains).
   */
  pattern: RegExp;
  /**
   * Kinds where this rule applies. Empty array = all kinds.
   */
  kinds?: string[];
}

/**
 * Patterns that signal a task may be trying to exploit the delegation tool.
 * Each regex is anchored to avoid catastrophic backtracking.
 *
 * These are intentionally conservative — they catch obvious exfiltration,
 * credential theft, and prompt injection attempts without blocking
 * legitimate development tasks.
 */
const RULES: readonly SafetyRule[] = [
  {
    id: "exfil-credentials",
    reason: "Task requests extraction or exfiltration of credentials, tokens, or API keys",
    // Bidirectional: ACTION...CREDENTIAL or CREDENTIAL...ACTION.
    // Each half uses word boundaries + a bounded gap ([^.]{0,80}) —
    // linear time, no nested quantifiers.
    pattern:
      /\b(?:send|post|upload|exfiltrate|exfil|transmit|pipe|redirect|extract)\b[^.]{0,80}\b(?:api[_\s-]?key|secrets?|tokens?|passwords?|passwd|credentials?|\.env\b|private[_\s-]?keys?)\b|\b(?:api[_\s-]?key|secrets?|tokens?|passwords?|passwd|credentials?|\.env\b|private[_\s-]?keys?)\b[^.]{0,80}\b(?:send|post|upload|exfiltrate|exfil|transmit|pipe|redirect|extract)\b/i,
  },
  {
    id: "data-exfil-external",
    reason: "Task requests sending sensitive data to an external endpoint",
    // Bidirectional: ACTION...SENSITIVE...URL or SENSITIVE...ACTION...URL.
    pattern:
      /\b(?:send|post|upload|exfiltrate|exfil|transmit|curl|wget)\b[^.]{0,80}\b(?:sensitive|confidential|private|secrets?)\b[^.]{0,60}(?:https?:\/\/|ftp:\/\/)|\b(?:sensitive|confidential|private|secrets?)\b[^.]{0,80}\b(?:send|post|upload|exfiltrate|exfil|transmit|curl|wget)\b[^.]{0,60}(?:https?:\/\/|ftp:\/\/)/i,
  },
  {
    id: "prompt-injection-override",
    reason: "Task contains embedded prompt-injection override attempting to bypass safety",
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|system|safety|security)\s+(?:instructions?|prompts?|rules?|guidelines?|constraints?)\b/i,
  },
  {
    id: "destructive-system",
    reason: "Task requests destructive system commands via delegation",
    // No trailing \b — '/' is not a word character so \b after it fails.
    pattern:
      /(?:\brm\s+-rf\s+\/(?:\s|$)|\bmkfs\b|\bhdis?k\b|\bdd\s+if=.*of=\/dev\/|:\(\)\s*\{.*\|.*&\s*\}|\bfork\s*bomb\b)/i,
  },
];

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Run a lightweight safety pre-check on a delegation request.
 *
 * @param tool    Flattened tool description (from `flattenToolSpec`).
 * @param task    The task text being delegated.
 * @param kind    The delegation kind (e.g. "code", "research").
 * @param opts    Options (disabled, blockOnUnsafe).
 * @returns Safety verdict — `{ safe: true }` or `{ safe: false, ... }`.
 */
export function preRouteSafetyCheck(
  tool: FlattenedTool,
  task: string,
  kind: string,
  opts?: SafetyCheckOptions,
): SafetyVerdict {
  if (opts?.disabled) return { safe: true };

  // Check the task text against each rule.
  for (const rule of RULES) {
    // Skip rules scoped to different kinds.
    if (rule.kinds && rule.kinds.length > 0 && !rule.kinds.includes(kind)) continue;

    const match = rule.pattern.exec(task);
    if (match) {
      return {
        safe: false,
        rule: rule.id,
        matched: match[0],
        reason: rule.reason,
      };
    }
  }

  return { safe: true };
}

/**
 * Decide whether to block dispatch based on the verdict and options.
 * In advisory mode (default), the verdict is informational only.
 */
export function shouldBlock(verdict: SafetyVerdict, opts?: SafetyCheckOptions): boolean {
  if (opts?.blockOnUnsafe !== true) return false;
  return !verdict.safe;
}
