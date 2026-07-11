/**
 * Standard category prefixes for typed facts.
 *
 * Inspired by the Proactive Memory Agent taxonomy (task requirements,
 * environment facts, prior attempts, diagnoses, open subgoals), extended
 * with OpenClaw-specific categories for infrastructure and personal context.
 *
 * Categories are OPTIONAL — existing facts simply lack the field. The LLM
 * extractor is prompted to tag new facts with the best-fit category; when
 * it omits one, `inferCategoryFromSlot` provides a heuristic fallback based
 * on the slot's namespace prefix.
 *
 * Usage in retrieval: pass `categoryFilter` to `retrieveTopK` to scope
 * results to one category (e.g. only "infra" facts when the query is
 * about network topology).
 */

/** The canonical set of category prefixes. */
export const TYPED_FACT_CATEGORIES = [
  "task", // Task requirements, steps, procedures
  "environment", // Runtime environment: OS, node version, paths
  "attempt", // Prior attempts, what was tried
  "diagnosis", // Diagnosed issues, root causes
  "subgoal", // Open subgoals, pending work
  "preference", // User preferences, defaults
  "infra", // Infrastructure: IPs, hostnames, ports, credentials locations
  "person", // People: names, roles, contact info
  "project", // Project-specific: repo paths, branch names, build commands
] as const;

export type TypedFactCategory = (typeof TYPED_FACT_CATEGORIES)[number];

/** Slot namespace → category mapping for heuristic fallback. */
const SLOT_PREFIX_TO_CATEGORY: ReadonlyArray<[RegExp, string]> = [
  [/^infra[:_]/, "infra"],
  [/^user[:_]/, "preference"],
  [/^person[:_]/, "person"],
  [/^project[:_]/, "project"],
  [/^task[:_]/, "task"],
  [/^env[:_]/, "environment"],
  [/^attempt[:_]/, "attempt"],
  [/^diag[:_]/, "diagnosis"],
  [/^subgoal[:_]/, "subgoal"],
  [/^server[:_]/, "infra"],
  [/^device[:_]/, "infra"],
  [/^network[:_]/, "infra"],
  [/^credential[:_]/, "infra"],
  [/^preference[:_]/, "preference"],
];

/**
 * Infer a category from a slot name when the LLM didn't provide one.
 * Returns the matched category or undefined when no heuristic matches.
 */
export function inferCategoryFromSlot(slot: string): string | undefined {
  const lower = slot.toLowerCase();
  for (const [pattern, category] of SLOT_PREFIX_TO_CATEGORY) {
    if (pattern.test(lower)) {
      return category;
    }
  }
  return undefined;
}

/**
 * Validate that a string is one of the canonical categories.
 * Returns the string if valid, undefined otherwise.
 */
export function validateCategory(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const lower = value.toLowerCase();
  return (TYPED_FACT_CATEGORIES as readonly string[]).includes(lower) ? lower : undefined;
}

/**
 * Resolve the final category: prefer the LLM-provided value, fall back to
 * slot-based inference, fall back to undefined (uncategorized).
 */
export function resolveCategory(explicit: string | undefined, slot: string): string | undefined {
  return validateCategory(explicit) ?? inferCategoryFromSlot(slot);
}
