import fsp from "node:fs/promises";
import path from "node:path";
import { resolveSkillForgePromotedSkillDir, resolveSkillForgeRetiredSkillDir } from "./paths.js";

export const LLM_REPLAY_TODO =
  "Phase 4 LLM-replay gate (leave-one-out re-run with the candidate skill loaded) requires an LLM provider; defer until provider chosen.";

const MIN_BODY_CHARS = 200;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export type GateVerdict = {
  status: "pass" | "fail";
  reasons: string[];
};

function frontmatterFields(frontmatter: string): { name?: string; description?: string } {
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/mu);
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/mu);
  const unquote = (raw: string): string => {
    const trimmed = raw.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
    }
    return trimmed;
  };
  return {
    name: nameMatch ? unquote(nameMatch[1]) : undefined,
    description: descriptionMatch ? unquote(descriptionMatch[1]) : undefined,
  };
}

export async function validateSkillDir(skillDir: string): Promise<GateVerdict> {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  let content: string;
  try {
    content = await fsp.readFile(skillMdPath, "utf8");
  } catch {
    return { status: "fail", reasons: ["SKILL.md missing"] };
  }
  const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/u);
  if (!frontmatterMatch) {
    return { status: "fail", reasons: ["Frontmatter missing or malformed"] };
  }
  const [, frontmatter, body] = frontmatterMatch;
  const { name, description } = frontmatterFields(frontmatter);
  const reasons: string[] = [];
  if (!name || name.length === 0) {
    reasons.push("name field missing or empty");
  } else if (!NAME_PATTERN.test(name)) {
    reasons.push(`name '${name}' does not match lowercase-hyphen schema`);
  }
  if (!description || description.length === 0) {
    reasons.push("description field missing or empty");
  }
  const bodyTrim = body.trim();
  if (bodyTrim.length < MIN_BODY_CHARS) {
    reasons.push(`body is too short (${bodyTrim.length} chars; minimum ${MIN_BODY_CHARS})`);
  }
  try {
    const scriptsStat = await fsp.stat(path.join(skillDir, "scripts"));
    if (scriptsStat.isDirectory()) {
      reasons.push(
        "scripts/ directory present (auto-promoted skills must be prose-only per AGENTS.md)",
      );
    }
  } catch {
    // No scripts/ — good.
  }
  return reasons.length === 0 ? { status: "pass", reasons: [] } : { status: "fail", reasons };
}

export async function nameCollisionCheck(params: {
  name: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GateVerdict> {
  const env = params.env ?? process.env;
  const reasons: string[] = [];
  const targets: Array<[string, string]> = [
    ["promoted", resolveSkillForgePromotedSkillDir({ name: params.name, env })],
    ["retired", resolveSkillForgeRetiredSkillDir({ name: params.name, env })],
  ];
  for (const [label, dir] of targets) {
    try {
      const stat = await fsp.stat(dir);
      if (stat.isDirectory()) {
        reasons.push(`name '${params.name}' collides with existing ${label} skill at ${dir}`);
      }
    } catch {
      // Not present — good.
    }
  }
  return reasons.length === 0 ? { status: "pass", reasons: [] } : { status: "fail", reasons };
}

export function llmReplayGateStub(): never {
  throw new Error(LLM_REPLAY_TODO);
}

export async function evaluateGate(params: {
  skillDir: string;
  name: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GateVerdict> {
  const validation = await validateSkillDir(params.skillDir);
  if (validation.status === "fail") {
    return validation;
  }
  const collision = await nameCollisionCheck({ name: params.name, env: params.env });
  if (collision.status === "fail") {
    return collision;
  }
  return { status: "pass", reasons: [] };
}
