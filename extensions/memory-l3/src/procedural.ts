/**
 * Procedural memory layer — ZenBrain Layer 5.
 *
 * Bridges skill-forge's promoted skills into the memory-l3 retrieval pipeline.
 * Promoted skills represent learned procedures ("how to do X") that can be
 * retrieved when the agent faces a similar situation. FSRS scoring applies
 * with longer half-lives (30 days) since procedural memories decay slowly.
 *
 * Skill-forge's promoted skills live at `~/.openclaw/skill-forge/skills/`
 * as SKILL.md files with YAML frontmatter. This module reads them and
 * presents them as ProceduralFacts for the retrieval tier system.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fsrsRetrievability } from "./scoring.js";
import type { L2Fact } from "./types.js";

export type ProceduralFact = {
  id: string;
  /** Skill name from skill-forge. */
  skillName: string;
  /** Detection lane. */
  lane: "tool-shape" | "error-recovery" | "explicit";
  /** Human-readable trigger description. */
  triggerDescription: string;
  /** Tool sequence the skill executes. */
  toolSequence: string[];
  /** Usage count from telemetry. */
  usageCount: number;
  /** Successful uses. */
  successCount: number;
  /** ms timestamp when promoted. */
  promotedAt: number;
  /** ms timestamp when last used. */
  lastUsedAt: number | null;
};

/** FSRS half-life for procedural memories (longer than semantic). */
const PROCEDURAL_HALF_LIFE_DAYS = 30;

/**
 * Resolve the skill-forge promoted skills directory.
 * Defaults to `~/.openclaw/skill-forge/skills/`; override via env or param.
 */
export function resolveSkillForgeDir(override?: string): string {
  if (override && override.length > 0) {
    return override;
  }
  const fromEnv = process.env.OPENCLAW_SKILL_FORGE_DIR;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".openclaw", "skill-forge", "skills");
}

/**
 * Parse a SKILL.md file's YAML frontmatter and extract structured data.
 * Returns null if the file can't be parsed as a valid skill.
 */
export function parseSkillMd(raw: string): {
  name: string;
  description: string;
  toolSequence: string[];
  lane: "tool-shape" | "error-recovery" | "explicit";
} | null {
  // Extract YAML frontmatter between --- fences
  const opener = raw.indexOf("---\n");
  if (opener !== 0) {
    return null;
  }
  const closeAt = raw.indexOf("\n---\n", opener + 4);
  if (closeAt < 0) {
    return null;
  }

  const frontRaw = raw.slice(opener + 4, closeAt);
  const body = raw.slice(closeAt + 5);

  // Simple YAML parsing (name, description — no dependency on yaml lib)
  let name = "";
  let description = "";
  for (const line of frontRaw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("name:")) {
      name = trimmed.slice(5).trim();
    } else if (trimmed.startsWith("description:")) {
      description = trimmed.slice(12).trim();
      // Strip wrapping quotes
      if (
        (description.startsWith('"') && description.endsWith('"')) ||
        (description.startsWith("'") && description.endsWith("'"))
      ) {
        description = description.slice(1, -1);
      }
    }
  }

  if (name.length === 0) {
    return null;
  }

  // Extract tool sequence from numbered list in body: "1. `tool_name`"
  const toolSequence: string[] = [];
  const toolPattern = /^\d+\.\s+`([^`]+)`/gm;
  let match: RegExpExecArray | null;
  while ((match = toolPattern.exec(body)) !== null) {
    const tool = match[1];
    if (tool !== undefined) {
      toolSequence.push(tool);
    }
  }

  // Detect lane from skill name prefix
  let lane: "tool-shape" | "error-recovery" | "explicit" = "explicit";
  if (name.includes("rep-") || name.includes("-rep-")) {
    lane = "tool-shape";
  } else if (name.includes("recover-") || name.includes("-recover-")) {
    lane = "error-recovery";
  }

  return { name, description, toolSequence, lane };
}

/**
 * Scan skill-forge's promoted skills directory and return ProceduralFacts.
 * Silently skips files that can't be parsed. Returns empty array when
 * the directory doesn't exist.
 */
export async function readPromotedSkills(skillForgeDir?: string): Promise<ProceduralFact[]> {
  const dir = resolveSkillForgeDir(skillForgeDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const facts: ProceduralFact[] = [];
  for (const entry of entries) {
    const skillMdPath = path.join(dir, entry, "SKILL.md");
    let raw: string;
    try {
      raw = await fs.readFile(skillMdPath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillMd(raw);
    if (!parsed) {
      continue;
    }

    // Check for telemetry data alongside SKILL.md
    let usageCount = 0;
    let successCount = 0;
    let lastUsedAt: number | null = null;
    try {
      const telRaw = await fs.readFile(path.join(dir, entry, "telemetry.json"), "utf8");
      const tel = JSON.parse(telRaw) as {
        usageCount?: number;
        successCount?: number;
        lastUsedAt?: number;
      };
      usageCount = typeof tel.usageCount === "number" ? tel.usageCount : 0;
      successCount = typeof tel.successCount === "number" ? tel.successCount : 0;
      lastUsedAt = typeof tel.lastUsedAt === "number" ? tel.lastUsedAt : null;
    } catch {
      // Telemetry file is optional
    }

    // promotedAt from filesystem mtime
    let promotedAt = Date.now();
    try {
      const stat = await fs.stat(skillMdPath);
      promotedAt = stat.mtimeMs;
    } catch {
      // Fallback to now
    }

    facts.push({
      id: `proc-${parsed.name}`,
      skillName: parsed.name,
      lane: parsed.lane,
      triggerDescription: parsed.description || `Procedure: ${parsed.name}`,
      toolSequence: parsed.toolSequence,
      usageCount,
      successCount,
      promotedAt,
      lastUsedAt,
    });
  }

  return facts;
}

/**
 * Convert a ProceduralFact to L2Fact shape for the scoring pipeline.
 *
 * Text combines trigger description + tool sequence for lexical matching.
 * Importance scales with successful usage (0.6 base + 0.1 per success, cap 0.95).
 * DedupKey is `procedural:<skillName>`.
 */
export function proceduralFactAsL2Fact(pf: ProceduralFact): L2Fact {
  const toolText = pf.toolSequence.length > 0 ? `. Tools: ${pf.toolSequence.join(" → ")}` : "";
  return {
    id: pf.id,
    text: `${pf.triggerDescription}${toolText}`,
    importance: Math.min(0.95, 0.6 + 0.1 * pf.successCount),
    createdAt: pf.promotedAt,
    dedupKey: `procedural:${pf.skillName}`,
  };
}

/**
 * FSRS retrievability for a procedural fact. Uses usageCount as recallCount
 * and a longer half-life (30 days) since skills decay slower than semantic facts.
 */
export function fsrsProceduralRetrievability(pf: ProceduralFact, now: number): number {
  const ageMs = now - pf.promotedAt;
  return fsrsRetrievability({
    ageMs,
    recallCount: Math.max(1, pf.usageCount),
    halfLifeDays: PROCEDURAL_HALF_LIFE_DAYS,
  });
}
