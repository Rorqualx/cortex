import fsp from "node:fs/promises";
import path from "node:path";
import { resolveSkillForgePromotedSkillDir } from "./paths.js";

// QW5 (2026-11-09 daily-research, Skill++-inspired): on promotion, rewrite the
// new skill's description against its nearest neighbors so similar skills
// differentiate instead of duplicating. A near-duplicate description is the
// exact pattern that loses displacement signal — the runner can't tell which
// of two look-alike skills to invoke, so both get passed over.
//
// The neighbor metric here is deterministic description-token Jaccard over
// sibling promoted skills (no network, no embedding provider at promotion
// time). The similarity function stays injectable so the embedding-cluster
// neighbors can slot in later without touching the rewrite/triple logic.

/** Similarity threshold above which a neighbor counts as "nearest". */
export const DEFAULT_NEIGHBOR_SIMILARITY_THRESHOLD = 0.35;

export type SkillDescriptionProfile = {
  name: string;
  description: string;
};

/** Parse the `description:` scalar out of a SKILL.md frontmatter block. */
export function parseSkillDescription(content: string): string | undefined {
  const m = content.match(/^description:\s*(.+)$/mu);
  if (!m?.[1]) return undefined;
  const raw = m[1].trim();
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
  }
  return raw;
}

/** Tokenize a description for similarity: lowercase words + kebab tool ids. */
export function descriptionTokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/gu) ?? []).filter((t) => t.length > 1),
  );
}

/** Jaccard overlap between two token sets. */
export function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

export type NearestNeighbor = SkillDescriptionProfile & { similarity: number };

/** Rank sibling descriptions and return the nearest neighbor above threshold. */
export function findNearestNeighbor(params: {
  description: string;
  neighbors: ReadonlyArray<SkillDescriptionProfile>;
  threshold?: number;
}): NearestNeighbor | undefined {
  const threshold = params.threshold ?? DEFAULT_NEIGHBOR_SIMILARITY_THRESHOLD;
  const tokens = descriptionTokens(params.description);
  let best: NearestNeighbor | undefined;
  for (const n of params.neighbors) {
    if (!n.description) continue;
    const similarity = tokenJaccard(tokens, descriptionTokens(n.description));
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { ...n, similarity };
    }
  }
  return best;
}

/**
 * Build the Skill++ differentiation triple: supports (shared focus) /
 * differs-from (nearest neighbor by name) / excludes (what this skill covers
 * that the neighbor does not). Returns the original description unchanged
 * when there is no near neighbor.
 */
export function buildDifferentiatedDescription(params: {
  name: string;
  description: string;
  neighbors: ReadonlyArray<SkillDescriptionProfile>;
  threshold?: number;
}): { description: string; nearest?: NearestNeighbor } {
  const nearest = findNearestNeighbor({
    description: params.description,
    neighbors: params.neighbors.filter((n) => n.name !== params.name),
    threshold: params.threshold,
  });
  if (!nearest) {
    return { description: params.description };
  }
  const own = descriptionTokens(params.description);
  const theirs = descriptionTokens(nearest.description);
  // Display lists keep only meaningful tokens: pure numbers (occurrence
  // counts like "12" vs "9") are not distinguishing content.
  const isMeaningful = (t: string) => /[a-z]/u.test(t);
  const shared = [...own].filter((t) => theirs.has(t) && isMeaningful(t)).slice(0, 4);
  const unique = [...own].filter((t) => !theirs.has(t) && isMeaningful(t)).slice(0, 4);
  const parts = [
    `Skill++: supports ${shared.length > 0 ? shared.join(", ") : "the same lane"};`,
    `differs from ${nearest.name} (nearest, ${(nearest.similarity * 100).toFixed(0)}% description overlap);`,
    `excludes ${unique.length > 0 ? unique.join(", ") : "nothing distinct"}.`,
  ];
  return { description: `${params.description} ${parts.join(" ")}`, nearest };
}

/** Escape a YAML scalar the same way the distiller writes descriptions. */
function escapeYamlScalar(value: string): string {
  if (value.includes("\n") || /^[?\-*&!|>%@`]/u.test(value) || /:\s/u.test(value)) {
    return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
  }
  return value;
}

/**
 * Rewrite the promoted SKILL.md description in place with the differentiated
 * triple. Best-effort by design — a differentiation failure must never
 * retro-fail a completed promotion.
 */
export async function differentiatePromotedSkillDescription(params: {
  name: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ description: string; nearest?: NearestNeighbor } | undefined> {
  const env = params.env ?? process.env;
  const promotedDir = resolveSkillForgePromotedSkillDir({ name: params.name, env });
  const skillMdPath = path.join(promotedDir, "SKILL.md");
  let content: string;
  try {
    content = await fsp.readFile(skillMdPath, "utf8");
  } catch {
    return undefined;
  }
  const description = parseSkillDescription(content);
  if (!description) return undefined;
  const neighbors: SkillDescriptionProfile[] = [];
  try {
    for (const entry of await fsp.readdir(path.dirname(promotedDir), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === params.name) continue;
      try {
        const siblingContent = await fsp.readFile(
          path.join(path.dirname(promotedDir), entry.name, "SKILL.md"),
          "utf8",
        );
        const siblingDescription = parseSkillDescription(siblingContent);
        if (siblingDescription) {
          neighbors.push({ name: entry.name, description: siblingDescription });
        }
      } catch {
        // Sibling without a readable SKILL.md — skip.
      }
    }
  } catch {
    // Promoted root unreadable — differentiate against nothing.
  }
  if (neighbors.length === 0) return undefined;
  const result = buildDifferentiatedDescription({
    name: params.name,
    description,
    neighbors,
  });
  if (!result.nearest) return undefined;
  const rewritten = content.replace(
    /^(description:\s*)(.+)$/mu,
    (_m, prefix: string, _old: string) => `${prefix}${escapeYamlScalar(result.description)}`,
  );
  await fsp.writeFile(skillMdPath, rewritten, "utf8");
  return result;
}
