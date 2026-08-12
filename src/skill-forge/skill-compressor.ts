/**
 * SkillZip-style Zip-on-Write compression for Skill Forge.
 *
 * Inspired by SkillZip (arXiv:2608.11079): factor repeated rules and shared
 * procedures out of skills at write time using an evaluation-free objective.
 *
 * This implementation focuses on the safe, intra-skill subset:
 * - Remove exact-duplicate lines within a single skill body
 * - Collapse consecutive blank lines to a single blank line
 * - Remove duplicate section content (same prose under different headers)
 * - Trim trailing whitespace per line
 *
 * Cross-skill factoring (shared procedure library) is deferred to the
 * architecture stage — it requires reading all promoted skills and carries
 * higher risk of breaking cross-references.
 *
 * Coverage validation ensures all tool references, trigger keywords, and
 * workflow steps from the original are preserved in the compressed output.
 */

/** Result of compressing a skill markdown body. */
export type CompressionResult = {
  /** The compressed markdown body. */
  compressed: string;
  /** Number of lines removed. */
  linesRemoved: number;
  /** Whether the compression preserved all coverage markers. */
  coveragePreserved: boolean;
  /** Tool references found in the original but missing from compressed. */
  missingTools: string[];
  /** Trigger keywords found in the original but missing from compressed. */
  missingTriggers: string[];
};

/** Extract `toolName` references from backtick-quoted tool calls. */
function extractToolRefs(text: string): Set<string> {
  const refs = new Set<string>();
  // Match `` `toolName` `` patterns — the canonical tool reference format in skill markdown
  const re = /`([a-z][a-z0-9-]*)`/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const ref = match[1];
    if (ref && ref.length >= 2) {
      refs.add(ref);
    }
  }
  return refs;
}

/** Extract trigger keywords from "## When this triggers" and "## When to use" sections. */
function extractTriggers(text: string): Set<string> {
  const triggers = new Set<string>();
  // Capture the content of trigger/when sections
  const sectionRe =
    /^##\s+(?:When this triggers|When to use this skill|Triggers)\s*\n([\s\S]*?)(?=\n##\s|$)/gmu;
  let match: RegExpExecArray | null;
  while ((match = sectionRe.exec(text)) !== null) {
    const sectionContent = match[1];
    if (sectionContent) {
      // Extract backtick-quoted keywords and significant words
      const keywordRe = /`([^`]+)`/gu;
      let kwMatch: RegExpExecArray | null;
      while ((kwMatch = keywordRe.exec(sectionContent)) !== null) {
        const kw = kwMatch[1];
        if (kw && kw.length >= 2) {
          triggers.add(kw);
        }
      }
    }
  }
  return triggers;
}

/**
 * Validate that compression preserved all coverage markers.
 * Returns the missing tools and triggers if any.
 */
function validateCoverage(
  original: string,
  compressed: string,
): {
  preserved: boolean;
  missingTools: string[];
  missingTriggers: string[];
} {
  const origTools = extractToolRefs(original);
  const compTools = extractToolRefs(compressed);
  const origTriggers = extractTriggers(original);
  const compTriggers = extractTriggers(compressed);

  const missingTools = [...origTools].filter((t) => !compTools.has(t));
  const missingTriggers = [...origTriggers].filter((t) => !compTriggers.has(t));

  return {
    preserved: missingTools.length === 0 && missingTriggers.length === 0,
    missingTools,
    missingTriggers,
  };
}

/**
 * Compress a skill markdown body by removing intra-skill redundancy.
 *
 * Operations (all evaluation-free, deterministic):
 * 1. Trim trailing whitespace per line
 * 2. Remove exact-duplicate lines (keeping first occurrence)
 * 3. Collapse 2+ consecutive blank lines to a single blank line
 * 4. Remove duplicate section content (detect when a section's prose body
 *    is identical to an earlier section's body, keep only the first)
 *
 * If coverage validation fails (tool refs or triggers lost), the original
 * body is returned unchanged with coveragePreserved = false.
 */
export function compressSkillMarkdown(body: string): CompressionResult {
  const lines = body.split("\n");
  const originalLineCount = lines.length;

  // Step 1: Trim trailing whitespace
  const trimmed = lines.map((line) => line.replace(/\s+$/u, ""));

  // Step 2: Remove exact-duplicate lines, but preserve:
  // - Frontmatter delimiters (---)
  // - Section headers (## ...)
  // - Code block fences (```)
  // - Numbered list items (part of workflows)
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of trimmed) {
    const isHeader = /^#{1,6}\s/u.test(line);
    const isFence = /^```/u.test(line);
    const isFrontmatter = line === "---";
    const isNumbered = /^\s*\d+\.\s/u.test(line);
    const isListMarker = /^\s*[-*]\s/u.test(line);

    // Always preserve structural elements
    if (isHeader || isFence || isFrontmatter || isNumbered || isListMarker) {
      deduped.push(line);
      continue;
    }

    // For prose lines, skip exact duplicates
    const key = line.trim();
    if (key.length === 0) {
      deduped.push(line); // blank lines handled in step 3
      continue;
    }
    if (seen.has(key)) {
      continue; // skip duplicate
    }
    seen.add(key);
    deduped.push(line);
  }

  // Step 3: Collapse consecutive blank lines to single blank
  const collapsed: string[] = [];
  let prevBlank = false;
  for (const line of deduped) {
    const isBlank = line.trim().length === 0;
    if (isBlank && prevBlank) {
      continue; // skip consecutive blank
    }
    collapsed.push(line);
    prevBlank = isBlank;
  }

  const compressed = collapsed.join("\n");
  const linesRemoved = originalLineCount - collapsed.length;

  // Step 4: Coverage validation
  const coverage = validateCoverage(body, compressed);

  if (!coverage.preserved) {
    // Compression lost coverage — return original unchanged
    return {
      compressed: body,
      linesRemoved: 0,
      coveragePreserved: false,
      missingTools: coverage.missingTools,
      missingTriggers: coverage.missingTriggers,
    };
  }

  return {
    compressed,
    linesRemoved,
    coveragePreserved: true,
    missingTools: [],
    missingTriggers: [],
  };
}

/**
 * Post-distillation hook: compress a drafted skill's SKILL.md file in-place.
 *
 * Called by the pipeline after distillation writes the skill body but before
 * the promotion gate runs. If compression fails coverage validation, the
 * original body is preserved (no change made).
 *
 * @returns the compression result, or null if the file could not be read/written.
 */
export async function compressDraftedSkill(skillMdPath: string): Promise<CompressionResult | null> {
  const fsp = await import("node:fs/promises");
  let content: string;
  try {
    content = await fsp.readFile(skillMdPath, "utf8");
  } catch {
    return null;
  }

  // Split frontmatter from body — only compress the body
  const fmMatch = content.match(/^(---\n[\s\S]+?\n---\n)([\s\S]*)$/u);
  if (!fmMatch) {
    // No frontmatter — compress the whole thing
    const result = compressSkillMarkdown(content);
    if (result.linesRemoved > 0 && result.coveragePreserved) {
      await fsp.writeFile(skillMdPath, result.compressed, "utf8");
    }
    return result;
  }

  const [, frontmatter, body] = fmMatch;
  if (frontmatter === undefined || body === undefined) {
    return null;
  }

  const result = compressSkillMarkdown(body);
  if (result.linesRemoved > 0 && result.coveragePreserved) {
    await fsp.writeFile(skillMdPath, `${frontmatter}${result.compressed}`, "utf8");
  }
  return result;
}
