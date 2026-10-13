import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveSkillForgePromotedSkillDir,
  resolveSkillForgeRetiredSkillDir,
  resolveSkillForgeStagedSkillDir,
} from "./paths.js";
import {
  DEFAULT_DECAY_POLICY,
  advanceSkillLifecycle,
  demoteSkill,
  promoteStagedSkill,
  runDecaySweep,
} from "./promoter.js";
import {
  readTelemetry,
  recordSkillPromotion,
  recordSkillUsage,
  recordSkillUsageOutcome,
} from "./telemetry.js";

const VALID_BODY = `
# Test Skill

## Overview

This placeholder body is intentionally more than two hundred characters long
so the gate validator does not reject it for being too short. We need enough
text here to clear the minimum body threshold the gate enforces today.
`.trim();

function validSkill(name: string): string {
  return `---\nname: ${name}\ndescription: A valid description.\n---\n\n${VALID_BODY}\n`;
}

async function writeStagedSkill(stateDir: string, name: string, body: string): Promise<void> {
  const dir = resolveSkillForgeStagedSkillDir({
    name,
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
  });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "SKILL.md"), body, "utf8");
}

describe("promoteStagedSkill", () => {
  let stateDir: string;
  const env = (): NodeJS.ProcessEnv => ({
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  });

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-promote-"));
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("renames staged → promoted when the gate passes and records telemetry", async () => {
    await writeStagedSkill(stateDir, "ok-skill", validSkill("ok-skill"));
    const result = await promoteStagedSkill({ name: "ok-skill", env: env() });
    expect(result.status).toBe("promoted");
    if (result.status !== "promoted") {
      throw new Error("unreachable");
    }
    expect(result.promotedDir).toBe(
      resolveSkillForgePromotedSkillDir({ name: "ok-skill", env: env() }),
    );
    const stagedExists = await fsp
      .stat(resolveSkillForgeStagedSkillDir({ name: "ok-skill", env: env() }))
      .then(() => true)
      .catch(() => false);
    expect(stagedExists).toBe(false);
    const promotedExists = await fsp
      .stat(path.join(result.promotedDir, "SKILL.md"))
      .then(() => true)
      .catch(() => false);
    expect(promotedExists).toBe(true);
  });

  it("rejects skills with no self-correction mechanism when successScore < 1", async () => {
    await writeStagedSkill(stateDir, "no-sc-skill", validSkill("no-sc-skill"));
    const result = await promoteStagedSkill({
      name: "no-sc-skill",
      successScore: 0.5,
      scMechanism: "none",
      env: env(),
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("unreachable");
    }
    expect(result.verdict.reasons).toContain(
      "scMechanism:none requires a clean session (successScore >= 1)",
    );
    // Staged dir should still exist (not renamed/cleaned).
    const stagedStillExists = await fsp
      .stat(resolveSkillForgeStagedSkillDir({ name: "no-sc-skill", env: env() }))
      .then(() => true)
      .catch(() => false);
    expect(stagedStillExists).toBe(true);
  });

  it("threads the candidate success score into promotion telemetry", async () => {
    await writeStagedSkill(stateDir, "scored-skill", validSkill("scored-skill"));
    const result = await promoteStagedSkill({
      name: "scored-skill",
      successScore: 1,
      env: env(),
    });
    expect(result.status).toBe("promoted");
    const entry = await readTelemetry({ name: "scored-skill", env: env() });
    expect(entry?.successScore).toBe(1);
  });

  it("returns rejected and leaves staged intact when the gate fails", async () => {
    await writeStagedSkill(stateDir, "bad-skill", "no frontmatter\n");
    const result = await promoteStagedSkill({ name: "bad-skill", env: env() });
    expect(result.status).toBe("rejected");
    const stagedStillExists = await fsp
      .stat(resolveSkillForgeStagedSkillDir({ name: "bad-skill", env: env() }))
      .then(() => true)
      .catch(() => false);
    expect(stagedStillExists).toBe(true);
  });
});

describe("demoteSkill", () => {
  let stateDir: string;
  const env = (): NodeJS.ProcessEnv => ({
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  });

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-demote-"));
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("moves promoted → retired and writes retirement-reason.txt", async () => {
    const promotedDir = resolveSkillForgePromotedSkillDir({ name: "rip", env: env() });
    await fsp.mkdir(promotedDir, { recursive: true });
    await fsp.writeFile(path.join(promotedDir, "SKILL.md"), validSkill("rip"), "utf8");
    await recordSkillPromotion({ name: "rip", env: env() });

    const { retiredDir } = await demoteSkill({
      name: "rip",
      reason: "no longer relevant",
      env: env(),
    });
    expect(retiredDir).toBe(resolveSkillForgeRetiredSkillDir({ name: "rip", env: env() }));
    const reason = await fsp.readFile(path.join(retiredDir, "retirement-reason.txt"), "utf8");
    expect(reason.trim()).toBe("no longer relevant");
  });
});

describe("runDecaySweep", () => {
  let stateDir: string;
  const env = (): NodeJS.ProcessEnv => ({
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  });

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-decay-"));
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  async function setupPromotedSkill(name: string, promotedAtIso: string): Promise<void> {
    const promotedDir = resolveSkillForgePromotedSkillDir({ name, env: env() });
    await fsp.mkdir(promotedDir, { recursive: true });
    await fsp.writeFile(path.join(promotedDir, "SKILL.md"), validSkill(name), "utf8");
    await recordSkillPromotion({ name, now: new Date(promotedAtIso), env: env() });
  }

  it("demotes promoted skills that have been unused beyond the policy threshold", async () => {
    await setupPromotedSkill("stale", "2026-01-01T00:00:00Z");
    await setupPromotedSkill("fresh", "2026-05-15T00:00:00Z");
    await setupPromotedSkill("used", "2026-01-01T00:00:00Z");
    await recordSkillUsage({ name: "used", now: new Date("2026-05-01T00:00:00Z"), env: env() });

    const demoted = await runDecaySweep({
      policy: DEFAULT_DECAY_POLICY,
      now: new Date("2026-05-20T00:00:00Z"),
      env: env(),
    });
    expect(demoted.map((d) => d.name)).toEqual(["stale"]);
  });

  it("does not demote anything when the policy threshold has not been crossed", async () => {
    await setupPromotedSkill("recent", "2026-05-15T00:00:00Z");
    const demoted = await runDecaySweep({
      policy: DEFAULT_DECAY_POLICY,
      now: new Date("2026-05-20T00:00:00Z"),
      env: env(),
    });
    expect(demoted).toEqual([]);
  });
});

describe("skill lifecycle (2026-10-13 fitness gate)", () => {
  let stateDir: string;
  const env = (): NodeJS.ProcessEnv => ({
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  });

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-lifecycle-"));
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("promotions land as trial in telemetry and SKILL.md frontmatter", async () => {
    await writeStagedSkill(stateDir, "trial-skill", validSkill("trial-skill"));
    const result = await promoteStagedSkill({ name: "trial-skill", env: env() });
    expect(result.status).toBe("promoted");

    const entry = await readTelemetry({ name: "trial-skill", env: env() });
    expect(entry?.lifecycle).toBe("trial");

    const promotedSkillMd = path.join(
      resolveSkillForgePromotedSkillDir({ name: "trial-skill", env: env() }),
      "SKILL.md",
    );
    const content = await fsp.readFile(promotedSkillMd, "utf8");
    expect(content).toContain("forge-lifecycle: trial");
  });

  it("first successful task outcome flips trial to active (telemetry + SKILL.md)", async () => {
    await writeStagedSkill(stateDir, "flip-skill", validSkill("flip-skill"));
    await promoteStagedSkill({ name: "flip-skill", env: env() });
    await recordSkillUsage({ name: "flip-skill", poolSize: 1, env: env() });

    const stamped = await recordSkillUsageOutcome({
      name: "flip-skill",
      taskSucceeded: true,
      env: env(),
    });
    expect(stamped?.lifecycle).toBe("active");

    const entry = await readTelemetry({ name: "flip-skill", env: env() });
    expect(entry?.lifecycle).toBe("active");

    const promotedSkillMd = path.join(
      resolveSkillForgePromotedSkillDir({ name: "flip-skill", env: env() }),
      "SKILL.md",
    );
    const content = await fsp.readFile(promotedSkillMd, "utf8");
    expect(content).toContain("forge-lifecycle: active");
  });

  it("advanceSkillLifecycle walks trial→active→stable and no-ops at stable", async () => {
    await writeStagedSkill(stateDir, "walk-skill", validSkill("walk-skill"));
    await promoteStagedSkill({ name: "walk-skill", env: env() });

    const first = await advanceSkillLifecycle({ name: "walk-skill", env: env() });
    expect(first).toMatchObject({ status: "advanced", from: "trial", to: "active" });
    const second = await advanceSkillLifecycle({ name: "walk-skill", env: env() });
    expect(second).toMatchObject({ status: "advanced", from: "active", to: "stable" });
    const third = await advanceSkillLifecycle({ name: "walk-skill", env: env() });
    expect(third).toMatchObject({ status: "noop", lifecycle: "stable" });

    const content = await fsp.readFile(
      path.join(resolveSkillForgePromotedSkillDir({ name: "walk-skill", env: env() }), "SKILL.md"),
      "utf8",
    );
    expect(content).toContain("forge-lifecycle: stable");
  });

  it("advanceSkillLifecycle rejects skills with no promoted telemetry entry", async () => {
    const result = await advanceSkillLifecycle({ name: "ghost-skill", env: env() });
    expect(result).toMatchObject({ status: "rejected" });
  });

  it("demotion stamps retired in telemetry and the retired SKILL.md", async () => {
    const promotedDir = resolveSkillForgePromotedSkillDir({ name: "rip2", env: env() });
    await fsp.mkdir(promotedDir, { recursive: true });
    await fsp.writeFile(path.join(promotedDir, "SKILL.md"), validSkill("rip2"), "utf8");
    await recordSkillPromotion({ name: "rip2", env: env() });

    const { retiredDir } = await demoteSkill({
      name: "rip2",
      reason: "no longer relevant",
      env: env(),
    });
    const entry = await readTelemetry({ name: "rip2", env: env() });
    expect(entry?.lifecycle).toBe("retired");
    const content = await fsp.readFile(path.join(retiredDir, "SKILL.md"), "utf8");
    expect(content).toContain("forge-lifecycle: retired");
  });
});
