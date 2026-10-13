import type { SkillLifecycle } from "./types.js";

/** SKILL.md frontmatter field carrying the promoted-skill lifecycle state. */
export const SKILL_LIFECYCLE_FIELD = "forge-lifecycle";

/** Ordered lifecycle states for a promoted skill. */
export const SKILL_LIFECYCLES = [
  "trial",
  "active",
  "stable",
  "retired",
] as const satisfies readonly SkillLifecycle[];

/**
 * Backfill-safe lifecycle resolution: skills promoted before this field existed
 * carry no marker and MUST default to "active" — otherwise every existing
 * promoted recovery skill would silently stop auto-invoking.
 */
export function parseSkillLifecycle(raw: string | undefined): SkillLifecycle {
  const value = (raw ?? "").trim().toLowerCase();
  return (SKILL_LIFECYCLES as readonly string[]).includes(value)
    ? (value as SkillLifecycle)
    : "active";
}

/** Linear-time single-field extraction from a `---` frontmatter block (no regex). */
export function extractFrontmatterField(content: string, field: string): string | undefined {
  if (!content.startsWith("---\n")) {
    return undefined;
  }
  const blockEnd = content.indexOf("\n---", 4);
  const block = content.slice(4, blockEnd === -1 ? undefined : blockEnd);
  for (const line of block.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    if (line.slice(0, separator).trim() === field) {
      return line.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/** Lifecycle recorded in a SKILL.md body; absent field resolves to "active". */
export function readSkillLifecycleFromContent(content: string): SkillLifecycle {
  return parseSkillLifecycle(extractFrontmatterField(content, SKILL_LIFECYCLE_FIELD));
}

/**
 * Auto-invoke eligibility gate for forge skills: only proven lifecycles may
 * fire automatically. "trial" skills landed but have not yet shown fitness;
 * "retired" skills must never fire (belt-and-braces alongside directory moves).
 */
export function isAutoInvocableLifecycle(lifecycle: SkillLifecycle): boolean {
  return lifecycle === "active" || lifecycle === "stable";
}

/**
 * Insert or replace the lifecycle field in the frontmatter block of a SKILL.md
 * body, idempotently. Adds a minimal frontmatter block when none exists.
 * Linear-time string ops only.
 */
export function stampSkillLifecycleInFrontmatter(
  content: string,
  lifecycle: SkillLifecycle,
): string {
  const line = `${SKILL_LIFECYCLE_FIELD}: ${lifecycle}`;
  if (!content.startsWith("---\n")) {
    return `---\n${line}\n---\n\n${content}`;
  }
  const blockEnd = content.indexOf("\n---", 4);
  if (blockEnd === -1) {
    return `---\n${line}\n---\n${content.slice(4)}`;
  }
  const lines = content.slice(4, blockEnd).split("\n");
  const stamped: string[] = [];
  let replaced = false;
  for (const blockLine of lines) {
    const separator = blockLine.indexOf(":");
    if (
      !replaced &&
      separator > 0 &&
      blockLine.slice(0, separator).trim() === SKILL_LIFECYCLE_FIELD
    ) {
      stamped.push(line);
      replaced = true;
    } else {
      stamped.push(blockLine);
    }
  }
  if (!replaced) {
    stamped.push(line);
  }
  return `---\n${stamped.join("\n")}${content.slice(blockEnd)}`;
}
