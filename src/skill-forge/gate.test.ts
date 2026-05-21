import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateGate,
  llmReplayGateStub,
  LLM_REPLAY_TODO,
  nameCollisionCheck,
  validateSkillDir,
} from "./gate.js";
import { resolveSkillForgePromotedSkillDir } from "./paths.js";

const VALID_BODY = `
# Test Skill

## Overview

This is a placeholder body that is more than two hundred characters long
so that the validator does not reject it for being too short. We need
enough text here to clear the minimum body threshold the gate enforces.
`.trim();

function validSkill(name: string): string {
  return `---\nname: ${name}\ndescription: A valid description.\n---\n\n${VALID_BODY}\n`;
}

describe("validateSkillDir", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-gate-validate-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("fails when SKILL.md is missing", async () => {
    const verdict = await validateSkillDir(tmp);
    expect(verdict.status).toBe("fail");
    expect(verdict.reasons[0]).toMatch(/SKILL.md missing/u);
  });

  it("fails when frontmatter is malformed", async () => {
    await fsp.writeFile(path.join(tmp, "SKILL.md"), "no frontmatter here\n", "utf8");
    const verdict = await validateSkillDir(tmp);
    expect(verdict.status).toBe("fail");
    expect(verdict.reasons[0]).toMatch(/Frontmatter/u);
  });

  it("fails when name has uppercase or invalid chars", async () => {
    await fsp.writeFile(path.join(tmp, "SKILL.md"), validSkill("Bad_Name!"), "utf8");
    const verdict = await validateSkillDir(tmp);
    expect(verdict.status).toBe("fail");
    expect(verdict.reasons.some((r) => r.includes("lowercase-hyphen"))).toBe(true);
  });

  it("fails when body is too short", async () => {
    await fsp.writeFile(
      path.join(tmp, "SKILL.md"),
      `---\nname: short\ndescription: x\n---\n\ntiny\n`,
      "utf8",
    );
    const verdict = await validateSkillDir(tmp);
    expect(verdict.status).toBe("fail");
    expect(verdict.reasons.some((r) => r.includes("body is too short"))).toBe(true);
  });

  it("fails when scripts/ directory is present", async () => {
    await fsp.writeFile(path.join(tmp, "SKILL.md"), validSkill("ok-skill"), "utf8");
    await fsp.mkdir(path.join(tmp, "scripts"), { recursive: true });
    const verdict = await validateSkillDir(tmp);
    expect(verdict.status).toBe("fail");
    expect(verdict.reasons.some((r) => r.includes("scripts/"))).toBe(true);
  });

  it("passes on a well-formed skill", async () => {
    await fsp.writeFile(path.join(tmp, "SKILL.md"), validSkill("ok-skill"), "utf8");
    const verdict = await validateSkillDir(tmp);
    expect(verdict).toEqual({ status: "pass", reasons: [] });
  });

  it("accepts a quoted description with colons", async () => {
    const body = `---\nname: ok\ndescription: "Workflow: read then grep"\n---\n\n${VALID_BODY}\n`;
    await fsp.writeFile(path.join(tmp, "SKILL.md"), body, "utf8");
    expect((await validateSkillDir(tmp)).status).toBe("pass");
  });
});

describe("nameCollisionCheck", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-gate-collision-"));
  });
  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });
  const env = (): NodeJS.ProcessEnv => ({
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  });

  it("passes when no promoted/retired skill exists", async () => {
    expect((await nameCollisionCheck({ name: "fresh", env: env() })).status).toBe("pass");
  });

  it("fails when a promoted skill with the same name already exists", async () => {
    const dir = resolveSkillForgePromotedSkillDir({ name: "dup", env: env() });
    await fsp.mkdir(dir, { recursive: true });
    const verdict = await nameCollisionCheck({ name: "dup", env: env() });
    expect(verdict.status).toBe("fail");
    expect(verdict.reasons[0]).toMatch(/collides/u);
  });
});

describe("llmReplayGateStub", () => {
  it("throws with the deferred-implementation marker", () => {
    expect(() => llmReplayGateStub()).toThrow(LLM_REPLAY_TODO);
  });
});

describe("evaluateGate", () => {
  let stateDir: string;
  let stagedSkillDir: string;
  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-gate-eval-"));
    stagedSkillDir = path.join(stateDir, "skill-forge", "skills", "_staging", "candidate");
    await fsp.mkdir(stagedSkillDir, { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("returns pass when both validation and collision check pass", async () => {
    await fsp.writeFile(path.join(stagedSkillDir, "SKILL.md"), validSkill("candidate"), "utf8");
    const verdict = await evaluateGate({
      skillDir: stagedSkillDir,
      name: "candidate",
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    });
    expect(verdict).toEqual({ status: "pass", reasons: [] });
  });

  it("short-circuits on validation failure", async () => {
    await fsp.writeFile(path.join(stagedSkillDir, "SKILL.md"), "no frontmatter", "utf8");
    const verdict = await evaluateGate({
      skillDir: stagedSkillDir,
      name: "candidate",
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    });
    expect(verdict.status).toBe("fail");
    expect(verdict.reasons.some((r) => r.includes("Frontmatter"))).toBe(true);
  });
});
