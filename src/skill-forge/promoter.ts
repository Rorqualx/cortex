import fsp from "node:fs/promises";
import path from "node:path";
import { evaluateGate, type GateVerdict } from "./gate.js";
import { stampSkillLifecycleInFrontmatter } from "./lifecycle.js";
import {
  resolveSkillForgePromotedSkillDir,
  resolveSkillForgeRetiredSkillDir,
  resolveSkillForgeStagedSkillDir,
} from "./paths.js";
import {
  listTelemetryEntries,
  readTelemetry,
  recordSkillDemotion,
  recordSkillLifecycle,
  recordSkillPromotion,
} from "./telemetry.js";
import type { SkillLifecycle } from "./types.js";

export type PromotionResult =
  | {
      status: "promoted";
      name: string;
      promotedDir: string;
      verdict: GateVerdict;
    }
  | { status: "rejected"; name: string; verdict: GateVerdict };

/** Stamp the lifecycle marker into a skill directory's SKILL.md (best-effort). */
async function stampLifecycleInSkillMd(dir: string, lifecycle: SkillLifecycle): Promise<void> {
  const skillMdPath = path.join(dir, "SKILL.md");
  try {
    const content = await fsp.readFile(skillMdPath, "utf8");
    await fsp.writeFile(skillMdPath, stampSkillLifecycleInFrontmatter(content, lifecycle), "utf8");
  } catch {
    // A dir without SKILL.md cannot carry the marker; telemetry still records
    // the lifecycle.
  }
}

export async function promoteStagedSkill(params: {
  name: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  successScore?: number;
  scMechanism?:
    | "constraint_verification"
    | "strategy_comparison"
    | "reasoning_revisitation"
    | "none";
}): Promise<PromotionResult> {
  const env = params.env ?? process.env;
  // Skills with no intrinsic self-correction mechanism need a higher bar:
  // they must come from a fully clean session (successScore >= 1).
  if (params.scMechanism === "none" && (params.successScore ?? 0) < 1) {
    return {
      status: "rejected",
      name: params.name,
      verdict: {
        status: "fail",
        reasons: ["scMechanism:none requires a clean session (successScore >= 1)"],
      },
    };
  }
  const stagedDir = resolveSkillForgeStagedSkillDir({ name: params.name, env });
  const verdict = await evaluateGate({
    skillDir: stagedDir,
    name: params.name,
    successScore: params.successScore,
    env,
  });
  if (verdict.status === "fail") {
    return { status: "rejected", name: params.name, verdict };
  }
  const promotedDir = resolveSkillForgePromotedSkillDir({ name: params.name, env });
  await fsp.mkdir(path.dirname(promotedDir), { recursive: true });
  await fsp.rename(stagedDir, promotedDir);
  // 2026-10-13 fitness gate: promoted skills land in "trial" — resolved in the
  // library but not auto-invokable until fitness is proven (first successful
  // task flips trial→active via recordSkillUsageOutcome).
  await stampLifecycleInSkillMd(promotedDir, "trial");
  await recordSkillPromotion({
    name: params.name,
    now: params.now,
    successScore: params.successScore,
    env,
  });
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
  await stampLifecycleInSkillMd(retiredDir, "retired");
  await recordSkillDemotion({ name: params.name, reason: params.reason, now: params.now, env });
  return { retiredDir };
}

/** Allowed forward lifecycle transitions for a promoted skill. */
const LIFECYCLE_ADVANCEMENTS: Partial<Record<SkillLifecycle, Exclude<SkillLifecycle, "retired">>> =
  {
    trial: "active",
    active: "stable",
  };

export type LifecycleAdvancementResult =
  | {
      status: "advanced";
      name: string;
      from: SkillLifecycle;
      to: SkillLifecycle;
      promotedDir: string;
    }
  | { status: "noop"; name: string; lifecycle: SkillLifecycle }
  | { status: "rejected"; name: string; reason: string };

/**
 * Advance a promoted skill one lifecycle step forward (trial→active,
 * active→stable). Updates the telemetry entry and mirrors the marker into the
 * promoted SKILL.md frontmatter, which the recovery auto-invoke gate reads.
 * Legacy entries without a lifecycle backfill to "active" (see
 * parseSkillLifecycle), so pre-existing promoted skills advance toward
 * "stable" rather than being re-gated as trial.
 */
export async function advanceSkillLifecycle(params: {
  name: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LifecycleAdvancementResult> {
  const env = params.env ?? process.env;
  const entry = await readTelemetry({ name: params.name, env });
  if (!entry || entry.status !== "promoted") {
    return {
      status: "rejected",
      name: params.name,
      reason: "no promoted skill telemetry entry",
    };
  }
  const current: SkillLifecycle = entry.lifecycle ?? "active";
  const next = LIFECYCLE_ADVANCEMENTS[current];
  if (!next) {
    return { status: "noop", name: params.name, lifecycle: current };
  }
  await recordSkillLifecycle({ name: params.name, lifecycle: next, env });
  return {
    status: "advanced",
    name: params.name,
    from: current,
    to: next,
    promotedDir: resolveSkillForgePromotedSkillDir({ name: params.name, env }),
  };
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
