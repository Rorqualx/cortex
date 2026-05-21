import fsp from "node:fs/promises";
import path from "node:path";
import { evaluateGate, type GateVerdict } from "./gate.js";
import {
  resolveSkillForgePromotedSkillDir,
  resolveSkillForgeRetiredSkillDir,
  resolveSkillForgeStagedSkillDir,
} from "./paths.js";
import { listTelemetryEntries, recordSkillDemotion, recordSkillPromotion } from "./telemetry.js";

export type PromotionResult =
  | {
      status: "promoted";
      name: string;
      promotedDir: string;
      verdict: GateVerdict;
    }
  | { status: "rejected"; name: string; verdict: GateVerdict };

export async function promoteStagedSkill(params: {
  name: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<PromotionResult> {
  const env = params.env ?? process.env;
  const stagedDir = resolveSkillForgeStagedSkillDir({ name: params.name, env });
  const verdict = await evaluateGate({ skillDir: stagedDir, name: params.name, env });
  if (verdict.status === "fail") {
    return { status: "rejected", name: params.name, verdict };
  }
  const promotedDir = resolveSkillForgePromotedSkillDir({ name: params.name, env });
  await fsp.mkdir(path.dirname(promotedDir), { recursive: true });
  await fsp.rename(stagedDir, promotedDir);
  await recordSkillPromotion({ name: params.name, now: params.now, env });
  return { status: "promoted", name: params.name, promotedDir, verdict };
}

export async function demoteSkill(params: {
  name: string;
  reason: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<{ retiredDir: string }> {
  const env = params.env ?? process.env;
  const promotedDir = resolveSkillForgePromotedSkillDir({ name: params.name, env });
  const retiredDir = resolveSkillForgeRetiredSkillDir({ name: params.name, env });
  await fsp.mkdir(path.dirname(retiredDir), { recursive: true });
  await fsp.rename(promotedDir, retiredDir);
  await fsp.writeFile(path.join(retiredDir, "retirement-reason.txt"), `${params.reason}\n`, "utf8");
  await recordSkillDemotion({ name: params.name, reason: params.reason, now: params.now, env });
  return { retiredDir };
}

export type DecayPolicy = {
  maxUnusedDays: number;
};

export const DEFAULT_DECAY_POLICY: DecayPolicy = { maxUnusedDays: 30 };

function daysSince(timestamp: string, now: Date): number {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    return Number.POSITIVE_INFINITY;
  }
  return (now.getTime() - ms) / (1000 * 60 * 60 * 24);
}

export type DecayedSkill = { name: string; reason: string };

export async function runDecaySweep(params: {
  policy?: DecayPolicy;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<DecayedSkill[]> {
  const policy = params.policy ?? DEFAULT_DECAY_POLICY;
  const now = params.now ?? new Date();
  const env = params.env ?? process.env;
  const demoted: DecayedSkill[] = [];
  for (const entry of await listTelemetryEntries(env)) {
    if (entry.status !== "promoted") {
      continue;
    }
    if (entry.usageCount > 0) {
      continue;
    }
    const reference = entry.promotedAt ?? entry.createdAt;
    const days = daysSince(reference, now);
    if (days < policy.maxUnusedDays) {
      continue;
    }
    const reason = `unused for ${days.toFixed(1)} days since promotion (policy: ${policy.maxUnusedDays})`;
    try {
      await demoteSkill({ name: entry.name, reason, now, env });
      demoted.push({ name: entry.name, reason });
    } catch {
      // Skill directory may have been removed externally; skip.
    }
  }
  return demoted;
}
