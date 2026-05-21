import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Candidate } from "./detector.js";
import {
  DISTILLER_PROSE_TODO,
  distillCandidateToStaging,
  normalizeSkillName,
  skillNameForCandidate,
} from "./distiller.js";

describe("normalizeSkillName", () => {
  it("lowercases, replaces non-alphanumerics with hyphens, collapses dashes", () => {
    expect(normalizeSkillName("My Cool Skill!!!  v2")).toBe("my-cool-skill-v2");
    expect(normalizeSkillName("--double--dash--")).toBe("double-dash");
    expect(normalizeSkillName("")).toBe("unnamed");
    expect(normalizeSkillName("////")).toBe("unnamed");
  });

  it("clamps to 64 characters", () => {
    const long = "a".repeat(200);
    expect(normalizeSkillName(long)).toHaveLength(64);
  });
});

describe("skillNameForCandidate", () => {
  it("prefixes all generated names with forge-", () => {
    const rep: Candidate = {
      lane: "tool-shape",
      candidateId: "abcdef1234567890",
      toolShapeHash: "abcdef1234567890",
      toolSequence: ["read_file", "grep"],
      captureDirs: ["/a", "/b", "/c"],
      occurrences: 3,
    };
    expect(skillNameForCandidate(rep).startsWith("forge-")).toBe(true);
  });

  it("uses lane-specific naming components", () => {
    const recovery: Candidate = {
      lane: "error-recovery",
      candidateId: "1234567890abcdef",
      captureDir: "/cap",
      toolSequence: ["mkdir"],
      failingTool: "write_file",
      recoveringTool: "mkdir",
      rationale: "r",
    };
    const name = skillNameForCandidate(recovery);
    expect(name).toContain("recover");
    expect(name).toContain("write-file");
    expect(name).toContain("mkdir");
  });
});

describe("distillCandidateToStaging", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-distiller-test-"));
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("writes a SKILL.md under <stateDir>/skill-forge/skills/_staging/<name>/", async () => {
    const candidate: Candidate = {
      lane: "explicit",
      candidateId: "1234567890abcdef",
      captureDir: "/cap/exp-1",
      toolSequence: ["read_file", "grep"],
      matchedPhrase: "turn this into a skill",
      promptExcerpt: "Hey, can you turn this into a skill please",
      rationale: 'User explicitly asked: "turn this into a skill"',
    };
    const result = await distillCandidateToStaging({
      candidate,
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    });
    expect(result.name).toMatch(/^forge-explicit-/u);
    expect(result.skillMdPath).toBe(
      path.join(stateDir, "skill-forge", "skills", "_staging", result.name, "SKILL.md"),
    );
    const content = await fsp.readFile(result.skillMdPath, "utf8");
    expect(content).toContain(`name: ${result.name}`);
    expect(content).toMatch(/^---\nname:/u);
    expect(content).toContain(DISTILLER_PROSE_TODO);
    expect(content).toContain("read_file");
    expect(content).toContain("grep");
    expect(content).toContain("turn this into a skill");
  });

  it("quotes the description when it contains YAML-significant characters", async () => {
    const candidate: Candidate = {
      lane: "tool-shape",
      candidateId: "h".repeat(16),
      toolShapeHash: "h".repeat(16),
      toolSequence: ["a:b", "c"],
      captureDirs: ["/x", "/y", "/z"],
      occurrences: 3,
    };
    const result = await distillCandidateToStaging({
      candidate,
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    });
    const content = await fsp.readFile(result.skillMdPath, "utf8");
    const descLine = content.split("\n").find((line) => line.startsWith("description:"));
    expect(descLine).toBeDefined();
    expect(descLine).toContain('"');
  });

  it("renders the tool sequence as a numbered list and notes occurrences for tool-shape lane", async () => {
    const candidate: Candidate = {
      lane: "tool-shape",
      candidateId: "h".repeat(16),
      toolShapeHash: "h".repeat(16),
      toolSequence: ["read_file", "grep", "edit_file"],
      captureDirs: ["/a", "/b", "/c", "/d"],
      occurrences: 4,
    };
    const result = await distillCandidateToStaging({
      candidate,
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    });
    const content = await fsp.readFile(result.skillMdPath, "utf8");
    expect(content).toContain("1. `read_file`");
    expect(content).toContain("2. `grep`");
    expect(content).toContain("3. `edit_file`");
    expect(content).toContain("4 captured sessions");
  });
});
