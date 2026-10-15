import fsp from "node:fs/promises";
import path from "node:path";
import {
  scanSkillBundle,
  writeCapabilityScanSidecar,
  type CapabilityScanResult,
} from "./capability-scan.js";
import { evaluateGate, type GateVerdict } from "./gate.js";
import { stampSkillLifecycleInFrontmatter } from "./lifecycle.js";
import {
  resolveSkillForgePromotedSkillDir,
  resolveSkillForgeRetiredSkillDir,
  resolveSkillForgeStagedSkillDir,
} from "./paths.js";
import {
  judgeSkillSecurity,
  writeSecurityJudgeSidecar,
  type SecurityJudgeOutcome,
} from "./security-judge.js";
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
      /**
       * Prompted-judge malicious-skill screen (advisory-first, 2026-10-14
       * QW3). Present only when the judge actually ran; skipped/failed runs
       * are logged but omitted. Never blocks promotion in advisory mode.
       */
      securityJudge?: SecurityJudgeOutcome;
      /**
       * Deterministic capability vector (display-only, 2026-10-15 QW2).
       * Which capability classes (shell-exec / fs-read / fs-write /
       * network-egress / credential-access) the bundle references; recorded
       * as a sidecar. Informational only — never blocks promotion.
       */
      capabilityScan?: CapabilityScanResult;
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
  // Advisory security-judge screen (2026-10-14 QW3): run an LLM judge over
  // the promoted SKILL.md and record the verdict as a sidecar. Advisory for
  // one cycle — never blocks promotion. Trial lifecycle already keeps the
  // skill out of the auto-invoke set, so a suspicious verdict has a grace
  // period before activation could make it auto-invokable.
  let securityJudge: SecurityJudgeOutcome | undefined;
  try {
    const outcome = await judgeSkillSecurity({
      skillDir: promotedDir,
      name: params.name,
    });
    if (outcome.status === "ok") {
      await writeSecurityJudgeSidecar(promotedDir, outcome);
      if (outcome.verdict === "suspicious") {
        // Log-only enforcement for the advisory cycle.
        console.warn(
          `[skill-forge] security judge: suspicious verdict for '${params.name}' — ${outcome.rationale ?? "no rationale"} (${outcome.provider}/${outcome.modelId}); advisory mode, promotion proceeds`,
        );
      }
      securityJudge = outcome;
    } else {
      console.warn(
        `[skill-forge] security judge ${outcome.status} for '${params.name}': ${outcome.reason}`,
      );
    }
  } catch (error) {
    // Belt-and-braces: judgeSkillSecurity never throws, but a throw here
    // must not retro-fail a completed promotion.
    console.warn(
      `[skill-forge] security judge threw for '${params.name}': ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  // Deterministic capability vector (2026-10-15 QW2): static scan of the
  // promoted bundle recorded as a sidecar next to the judge verdict.
  // Display-only — the vector informs, it never gates. (UI surfacing of the
  // sidecar is the follow-up slice, mirroring the judge-verdict sidecar.)
  let capabilityScan: CapabilityScanResult | undefined;
  try {
    const scan = await scanSkillBundle(promotedDir);
    await writeCapabilityScanSidecar(promotedDir, scan);
    capabilityScan = scan;
  } catch (error) {
    // Belt-and-braces: a scan failure must not retro-fail a completed
    // promotion.
    console.warn(
      `[skill-forge] capability scan threw for '${params.name}': ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  return {
    status: "promoted",
    name: params.name,
    promotedDir,
    verdict,
    ...(securityJudge ? { securityJudge } : {}),
    ...(capabilityScan ? { capabilityScan } : {}),
  };
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
