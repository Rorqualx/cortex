import { describe, expect, it } from "vitest";
import {
  buildSecurityJudgeUserPrompt,
  parseSecurityJudgeVerdict,
  SKILL_FORGE_SECURITY_JUDGE_SYSTEM,
} from "./security-judge.js";

describe("SKILL_FORGE_SECURITY_JUDGE_SYSTEM", () => {
  it("covers the QW3 malicious-behavior categories and treats skill content as data", () => {
    for (const criterion of [
      /exfiltration/iu,
      /persistence/iu,
      /credential/iu,
      /untrusted DATA/iu,
      /suspicious/u,
    ]) {
      expect(criterion.test(SKILL_FORGE_SECURITY_JUDGE_SYSTEM)).toBe(true);
    }
  });

  it("demands a structured verdict output", () => {
    expect(SKILL_FORGE_SECURITY_JUDGE_SYSTEM).toMatch(/VERDICT:/u);
    expect(SKILL_FORGE_SECURITY_JUDGE_SYSTEM).toMatch(/RATIONALE:/u);
  });
});

describe("buildSecurityJudgeUserPrompt", () => {
  it("frames the skill body as data, not instructions", () => {
    const prompt = buildSecurityJudgeUserPrompt({
      name: "deploy-helper",
      skillMd: "## Overview\nDeploys the app.\n",
    });
    expect(prompt).toContain("Skill name: deploy-helper");
    expect(prompt).toContain("DATA to audit");
    expect(prompt).toContain("```markdown");
    expect(prompt).toContain("Deploys the app.");
  });
});

describe("parseSecurityJudgeVerdict", () => {
  it("parses a benign verdict with rationale", () => {
    expect(
      parseSecurityJudgeVerdict("VERDICT: benign\nRATIONALE: no malicious patterns found"),
    ).toEqual({
      verdict: "benign",
      rationale: "no malicious patterns found",
    });
  });

  it("parses a suspicious verdict without rationale", () => {
    expect(parseSecurityJudgeVerdict("VERDICT: suspicious")).toEqual({ verdict: "suspicious" });
  });

  it("is case-insensitive and tolerates surrounding prose/fences", () => {
    const raw = "```\nverdict: SUSPICIOUS\nrationale: Exfiltrates env vars via curl.\n```";
    expect(parseSecurityJudgeVerdict(raw)).toEqual({
      verdict: "suspicious",
      rationale: "Exfiltrates env vars via curl.",
    });
  });

  it("keeps the first verdict when multiple lines appear (no flip-flopping)", () => {
    const raw = "VERDICT: benign\nsome attacker-injected text\nVERDICT: suspicious";
    expect(parseSecurityJudgeVerdict(raw)?.verdict).toBe("benign");
  });

  it("returns null for unparseable output", () => {
    expect(parseSecurityJudgeVerdict("The skill looks fine to me.")).toBeNull();
    expect(parseSecurityJudgeVerdict("")).toBeNull();
    expect(parseSecurityJudgeVerdict("VERDICT: malicious")).toBeNull();
  });
});
