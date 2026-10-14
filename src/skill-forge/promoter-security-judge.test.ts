import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSkillForgePromotedSkillDir, resolveSkillForgeStagedSkillDir } from "./paths.js";
import { promoteStagedSkill } from "./promoter.js";
import { SECURITY_JUDGE_SIDECAR } from "./security-judge.js";

// Advisory security-judge wiring (2026-10-14 QW3): the judge is stubbed here
// so the promoter's advisory behavior (record + proceed, never block) is
// testable without an LLM.
vi.mock("./security-judge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./security-judge.js")>();
  return {
    ...actual,
    judgeSkillSecurity: vi.fn(),
  };
});

import { judgeSkillSecurity } from "./security-judge.js";

const judgeMock = vi.mocked(judgeSkillSecurity);

const VALID_BODY = `
# Judge Screen Skill

## Overview

This placeholder body is intentionally more than two hundred characters long
so the gate validator does not reject it for being too short. We need enough
text here to clear the minimum body threshold the gate enforces today. This
particular copy exercises the advisory security-judge wiring around
promotion, proving a suspicious verdict never blocks the rename.
`.trim();

async function writeStagedSkill(stateDir: string, name: string): Promise<void> {
  const dir = resolveSkillForgeStagedSkillDir({
    name,
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
  });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: A valid description.\n---\n\n${VALID_BODY}\n`,
    "utf8",
  );
}

describe("promoteStagedSkill advisory security judge", () => {
  let stateDir: string;
  const env = (): NodeJS.ProcessEnv => ({
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  });

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-judge-"));
    judgeMock.mockReset();
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("promotes anyway and records the sidecar when the judge says suspicious", async () => {
    judgeMock.mockResolvedValue({
      status: "ok",
      verdict: "suspicious",
      rationale: "curl to unknown host with env vars",
      provider: "zai",
      modelId: "glm-5.2",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeStagedSkill(stateDir, "screened-skill");
      const result = await promoteStagedSkill({ name: "screened-skill", env: env() });
      expect(result.status).toBe("promoted");
      if (result.status !== "promoted") {
        throw new Error("unreachable");
      }
      // Advisory: suspicious verdict is surfaced but never blocks.
      expect(result.securityJudge).toEqual({
        status: "ok",
        verdict: "suspicious",
        rationale: "curl to unknown host with env vars",
        provider: "zai",
        modelId: "glm-5.2",
      });
      const promotedDir = resolveSkillForgePromotedSkillDir({ name: "screened-skill", env: env() });
      const sidecar = JSON.parse(
        await fsp.readFile(path.join(promotedDir, SECURITY_JUDGE_SIDECAR), "utf8"),
      ) as Record<string, unknown>;
      expect(sidecar["verdict"]).toBe("suspicious");
      expect(sidecar["mode"]).toBe("advisory");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/suspicious/u));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("omits securityJudge from the result when the judge skips (no runtime config)", async () => {
    judgeMock.mockResolvedValue({ status: "skipped", reason: "runtime config unavailable" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeStagedSkill(stateDir, "unjudged-skill");
      const result = await promoteStagedSkill({ name: "unjudged-skill", env: env() });
      expect(result.status).toBe("promoted");
      if (result.status !== "promoted") {
        throw new Error("unreachable");
      }
      expect(result.securityJudge).toBeUndefined();
      const promotedDir = resolveSkillForgePromotedSkillDir({ name: "unjudged-skill", env: env() });
      await expect(
        fsp.readFile(path.join(promotedDir, SECURITY_JUDGE_SIDECAR), "utf8"),
      ).rejects.toThrow();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("still promotes when the judge throws (belt-and-braces catch)", async () => {
    judgeMock.mockRejectedValue(new Error("judge exploded"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeStagedSkill(stateDir, "throwing-judge-skill");
      const result = await promoteStagedSkill({ name: "throwing-judge-skill", env: env() });
      expect(result.status).toBe("promoted");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
