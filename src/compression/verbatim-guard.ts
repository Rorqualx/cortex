// F3 extractive-span guard (2026-08-28): deterministic extractive pass for
// tool-output compression. When a compressor paraphrases or restructures
// content, verbatim-critical spans (unique paths, device nodes, hex/ioctl
// constants, config keys, versions) can disappear. This guard re-attaches
// spans that (a) look verbatim-critical and (b) appeared exactly once in the
// source — bulk-duplicated tokens are legitimate compression targets and are
// left dropped. Measure of last resort only: when the compressed output
// already preserves the span, nothing is appended.
//
// Patterns are anchored and linear-time (no nested quantifiers) — kept
// ReDoS-safe per the skill-forge gate history.

const VERBATIM_PATTERNS: RegExp[] = [
  // Absolute or home-tilde file paths with at least one separator.
  /(?:^|[\s"'`(=;:])(\/(?:[\w.\-]+\/)+[\w.\-]+|~\/(?:[\w.\-]+\/)+[\w.\-]+)/g,
  // Device nodes.
  /(?:^|\s)(\/dev\/[\w.\-]+)/g,
  // Hex constants / ioctl codes.
  /\b0x[0-9a-fA-F]{2,16}\b/g,
  // KEY=VALUE config keys (key side).
  /(?:^|[\s;])((?:[A-Z][A-Z0-9_]{2,30}|[a-z][a-z0-9_]{2,30})=[^\s]+)/g,
  // Dotted or snake_case config/version identifiers.
  /\b[\w.\-]{2,24}\.[\w.\-]{2,24}\.[\w.\-]{2,24}\b/g,
];

const GUARD_TAIL_PREFIX = "[verbatim]";

/** Verbatim-critical spans found in `text` (deduped). */
export function extractVerbatimSpans(text: string): string[] {
  const counts = new Map<string, number>();
  if (text) {
    for (const pattern of VERBATIM_PATTERNS) {
      const re = new RegExp(
        pattern.source,
        pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
      );
      for (const m of text.matchAll(re)) {
        // Prefer the innermost capture when a leading-boundary group exists.
        const value = (m[1] ?? m[0]).trim();
        if (value.length >= 3) {
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
      }
    }
  }
  return [...counts.entries()].filter(([, n]) => n === 1).map(([v]) => v);
}

/**
 * Re-attach unique verbatim spans that compression dropped. Appends a single
 * capped tail line to `after`; returns `after` unchanged when nothing
 * verbatim-critical was lost.
 */
export function applyVerbatimGuard(
  before: string,
  after: string,
  opts?: { maxSpans?: number; maxChars?: number },
): string {
  const maxSpans = opts?.maxSpans ?? 12;
  const maxChars = opts?.maxChars ?? 400;
  const missing = extractVerbatimSpans(before).filter((span) => !after.includes(span));
  if (missing.length === 0) {
    return after;
  }
  const tail: string[] = [];
  let used = 0;
  for (const span of missing) {
    if (tail.length >= maxSpans || used + span.length > maxChars) {
      break;
    }
    tail.push(span);
    used += span.length + 3;
  }
  if (tail.length === 0) {
    return after;
  }
  return `${after}\n${GUARD_TAIL_PREFIX} ${tail.join(" · ")}`;
}
