import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveSkillForgeSkillsRoot,
  resolveSkillForgeTelemetryDir,
} from "../skill-forge/paths.js";
import {
  detectSkillForgeStaleState,
  repairSkillForgeStaleState,
} from "./doctor-skill-forge-state.js";

describe("doctor skill-forge stale state", () => {
  let stateDir: string;
  const env = (): NodeJS.ProcessEnv => ({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" });

  async function writeSkill(rel: string): Promise<void> {
    const dir = path.join(resolveSkillForgeSkillsRoot(env()), rel);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "SKILL.md"), "---\nname: x\ndescription: d\n---\n\nbody\n");
  }

  async function writeTelemetry(name: string, usageCount: number): Promise<void> {
    const dir = resolveSkillForgeTelemetryDir(env());
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, `${name}.json`),
      `${JSON.stringify({ name, status: "promoted", createdAt: "t", usageCount }, null, 2)}\n`,
    );
  }

  async function exists(p: string): Promise<boolean> {
    try {
      await fsp.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-doctor-"));
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("detects the orphaned legacy .staging dir and hashed recovery skills", async () => {
    const skillsRoot = resolveSkillForgeSkillsRoot(env());
    await fsp.mkdir(path.join(skillsRoot, ".staging", "old"), { recursive: true });
    await writeSkill("forge-recover-exec-via-exec-2b6ef7");
    await writeSkill("forge-recover-exec-via-exec"); // already-stable: must be ignored
    await writeSkill("some-other-skill"); // unrelated: must be ignored

    const state = await detectSkillForgeStaleState(env());
    expect(state.legacyStagingDir).toBe(path.join(skillsRoot, ".staging"));
    expect(state.hashedRecoverySkills.map((s) => s.name)).toEqual([
      "forge-recover-exec-via-exec-2b6ef7",
    ]);
    const recovery = state.hashedRecoverySkills[0];
    if (!recovery) throw new Error("expected hashed recovery skill");
    expect(recovery.stableName).toBe("forge-recover-exec-via-exec");
  });

  it("dry-run reports actions without mutating disk", async () => {
    const skillsRoot = resolveSkillForgeSkillsRoot(env());
    await fsp.mkdir(path.join(skillsRoot, ".staging"), { recursive: true });
    await writeSkill("forge-recover-write-file-via-mkdir-abc123");

    const result = await repairSkillForgeStaleState({ dryRun: true, env: env() });
    expect(result.changes.some((c) => c.includes("would remove"))).toBe(true);
    expect(result.changes.some((c) => c.includes("would rename"))).toBe(true);
    expect(await exists(path.join(skillsRoot, ".staging"))).toBe(true);
    expect(await exists(path.join(skillsRoot, "forge-recover-write-file-via-mkdir-abc123"))).toBe(
      true,
    );
  });

  it("removes the orphan and renames a lone hashed skill (preserving telemetry)", async () => {
    const skillsRoot = resolveSkillForgeSkillsRoot(env());
    await fsp.mkdir(path.join(skillsRoot, ".staging"), { recursive: true });
    await writeSkill("forge-recover-exec-via-exec-2b6ef7");
    await writeTelemetry("forge-recover-exec-via-exec-2b6ef7", 4);

    await repairSkillForgeStaleState({ dryRun: false, env: env() });

    expect(await exists(path.join(skillsRoot, ".staging"))).toBe(false);
    expect(await exists(path.join(skillsRoot, "forge-recover-exec-via-exec-2b6ef7"))).toBe(false);
    expect(await exists(path.join(skillsRoot, "forge-recover-exec-via-exec"))).toBe(true);
    const telDir = resolveSkillForgeTelemetryDir(env());
    expect(await exists(path.join(telDir, "forge-recover-exec-via-exec-2b6ef7.json"))).toBe(false);
    const moved = JSON.parse(
      await fsp.readFile(path.join(telDir, "forge-recover-exec-via-exec.json"), "utf8"),
    );
    expect(moved).toMatchObject({ name: "forge-recover-exec-via-exec", usageCount: 4 });
  });

  it("collapses multiple hashed variants of one capability to a single stable skill", async () => {
    const skillsRoot = resolveSkillForgeSkillsRoot(env());
    await writeSkill("forge-recover-exec-via-exec-2b6ef7");
    await writeSkill("forge-recover-exec-via-exec-900d89");

    const result = await repairSkillForgeStaleState({ dryRun: false, env: env() });

    expect(await exists(path.join(skillsRoot, "forge-recover-exec-via-exec"))).toBe(true);
    expect(await exists(path.join(skillsRoot, "forge-recover-exec-via-exec-2b6ef7"))).toBe(false);
    expect(await exists(path.join(skillsRoot, "forge-recover-exec-via-exec-900d89"))).toBe(false);
    expect(result.changes.some((c) => c.includes("renamed"))).toBe(true);
    expect(result.changes.some((c) => c.includes("duplicate"))).toBe(true);
  });
});
