/**
 * Doctor migration for stale SkillForge on-disk state left by earlier versions:
 *  - an orphaned `skills/.staging/` dir (the staging dir was renamed to
 *    `_staging`; the old one is no longer read by the runtime), and
 *  - pre-fix duplicate recovery skills whose names still carry the per-candidate
 *    hash suffix (`forge-recover-<a>-via-<b>-<6hex>`). The distiller now emits the
 *    stable `forge-recover-<a>-via-<b>` name, so the hashed promoted copies are
 *    collapsed to that canonical name (extras removed) to stop the duplicates.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { HealthRepairEffect } from "../flows/health-checks.js";
import {
  resolveSkillForgeSkillsRoot,
  resolveSkillForgeTelemetryDir,
} from "../skill-forge/paths.js";

// A hashed recovery name is the stable capability key plus a trailing 6-hex
// candidate-id suffix. The trailing-hash anchor keeps stable names (no suffix)
// and tool names that merely end in letters from matching.
const HASHED_RECOVERY_NAME = /^(forge-recover-.+-via-.+)-[0-9a-f]{6}$/u;

export type HashedRecoverySkill = {
  name: string;
  stableName: string;
  dir: string;
};

export type SkillForgeStaleState = {
  legacyStagingDir?: string;
  hashedRecoverySkills: HashedRecoverySkill[];
};

function stableRecoveryName(name: string): string | undefined {
  const match = name.match(HASHED_RECOVERY_NAME);
  if (!match) {
    return undefined;
  }
  const stable = match[1];
  if (stable === undefined) {
    return undefined;
  }
  // Guard the greedy capture: the collapsed name must still name a recover tool.
  return /^forge-recover-.+-via-.+$/u.test(stable) ? stable : undefined;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function detectSkillForgeStaleState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkillForgeStaleState> {
  const skillsRoot = resolveSkillForgeSkillsRoot(env);
  const state: SkillForgeStaleState = { hashedRecoverySkills: [] };

  const legacyStaging = path.join(skillsRoot, ".staging");
  if (await isDirectory(legacyStaging)) {
    state.legacyStagingDir = legacyStaging;
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return state;
  }
  for (const entry of entries) {
    // Only promoted skills live as bare dirs; `_staging`/`_retired`/`.staging`
    // are lifecycle dirs left to their own owners.
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) {
      continue;
    }
    const stableName = stableRecoveryName(entry.name);
    if (stableName && stableName !== entry.name) {
      state.hashedRecoverySkills.push({
        name: entry.name,
        stableName,
        dir: path.join(skillsRoot, entry.name),
      });
    }
  }
  return state;
}

export function summarizeSkillForgeStaleState(state: SkillForgeStaleState): string[] {
  const lines: string[] = [];
  if (state.legacyStagingDir) {
    lines.push(`Orphaned legacy SkillForge staging dir at ${state.legacyStagingDir}.`);
  }
  if (state.hashedRecoverySkills.length > 0) {
    lines.push(
      `${state.hashedRecoverySkills.length} pre-fix duplicate recovery skill(s) with hashed names to collapse.`,
    );
  }
  return lines;
}

async function removeTelemetry(name: string, env: NodeJS.ProcessEnv): Promise<void> {
  await fsp.rm(path.join(resolveSkillForgeTelemetryDir(env), `${name}.json`), { force: true });
}

async function renameTelemetry(
  oldName: string,
  newName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const dir = resolveSkillForgeTelemetryDir(env);
  const oldPath = path.join(dir, `${oldName}.json`);
  let raw: string;
  try {
    raw = await fsp.readFile(oldPath, "utf8");
  } catch {
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  parsed.name = newName;
  await fsp.writeFile(
    path.join(dir, `${newName}.json`),
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
  await fsp.rm(oldPath, { force: true });
}

export type SkillForgeStateRepairResult = {
  changes: string[];
  effects: HealthRepairEffect[];
};

export async function repairSkillForgeStaleState(params: {
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillForgeStateRepairResult> {
  const env = params.env ?? process.env;
  const dryRun = params.dryRun;
  const state = await detectSkillForgeStaleState(env);
  const changes: string[] = [];
  const effects: HealthRepairEffect[] = [];
  const skillsRoot = resolveSkillForgeSkillsRoot(env);

  if (state.legacyStagingDir) {
    changes.push(
      `${dryRun ? "would remove" : "removed"} orphaned legacy staging dir ${state.legacyStagingDir}`,
    );
    effects.push({
      kind: "state",
      action: dryRun
        ? "would-remove-legacy-skill-forge-staging"
        : "remove-legacy-skill-forge-staging",
      target: state.legacyStagingDir,
      dryRunSafe: false,
    });
    if (!dryRun) {
      await fsp.rm(state.legacyStagingDir, { recursive: true, force: true });
    }
  }

  // Track stable names claimed this run so a second hashed variant of the same
  // capability is removed rather than overwriting the first one we renamed.
  const claimed = new Set<string>();
  for (const skill of state.hashedRecoverySkills) {
    const stableDir = path.join(skillsRoot, skill.stableName);
    const stableExists = claimed.has(skill.stableName) || (await isDirectory(stableDir));
    if (stableExists) {
      changes.push(`${dryRun ? "would remove" : "removed"} duplicate recovery skill ${skill.name}`);
      effects.push({
        kind: "state",
        action: dryRun
          ? "would-remove-duplicate-recovery-skill"
          : "remove-duplicate-recovery-skill",
        target: skill.dir,
        dryRunSafe: false,
      });
      if (!dryRun) {
        await fsp.rm(skill.dir, { recursive: true, force: true });
        await removeTelemetry(skill.name, env);
      }
    } else {
      changes.push(`${dryRun ? "would rename" : "renamed"} ${skill.name} → ${skill.stableName}`);
      effects.push({
        kind: "state",
        action: dryRun ? "would-rename-recovery-skill" : "rename-recovery-skill",
        target: skill.dir,
        dryRunSafe: false,
      });
      claimed.add(skill.stableName);
      if (!dryRun) {
        await fsp.rename(skill.dir, stableDir);
        await renameTelemetry(skill.name, skill.stableName, env);
      }
    }
  }

  return { changes, effects };
}
