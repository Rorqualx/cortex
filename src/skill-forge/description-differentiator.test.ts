import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDifferentiatedDescription,
  descriptionTokens,
  differentiatePromotedSkillDescription,
  findNearestNeighbor,
  parseSkillDescription,
  tokenJaccard,
} from "./description-differentiator.js";

// QW5 (2026-11-09, Skill++-inspired): promotion-time description
// differentiation — supports / differs-from / excludes triple against the
// nearest promoted sibling. Pure-deterministic unit tests + one in-place
// rewrite test over an isolated OPENCLAW_STATE_DIR.

const SIMILAR_A =
  "Workflow seen 12 times across captured sessions: exec, read, write. Use when the same multi-step sequence keeps repeating across tasks.";
const SIMILAR_B =
  "Workflow seen 9 times across captured sessions: exec, read, edit. Use when the same multi-step sequence keeps repeating across tasks.";
const UNRELATED = "Recovery workflow: when http-request fails, recover with browser-fetch.";

describe("parseSkillDescription", () => {
  it("reads plain and quoted YAML scalars", () => {
    expect(parseSkillDescription("---\nname: x\ndescription: plain text\n---\n")).toBe(
      "plain text",
    );
    expect(parseSkillDescription('description: "quoted \\"inner\\" and \\\\ slash"')).toBe(
      'quoted "inner" and \\ slash',
    );
    expect(parseSkillDescription("---\nname: x\n---\n")).toBeUndefined();
  });
});

describe("tokenJaccard / descriptionTokens", () => {
  it("scores overlap between 0 and 1 and handles empty sets", () => {
    const a = descriptionTokens(SIMILAR_A);
    const b = descriptionTokens(SIMILAR_B);
    expect(tokenJaccard(a, b)).toBeGreaterThan(0.5);
    expect(tokenJaccard(a, descriptionTokens(UNRELATED))).toBeLessThan(0.3);
    expect(tokenJaccard(new Set(), b)).toBe(0);
  });
});

describe("findNearestNeighbor", () => {
  it("picks the most similar sibling above threshold", () => {
    const nearest = findNearestNeighbor({
      description: SIMILAR_A,
      neighbors: [
        { name: "forge-rep-exec-read-edit", description: SIMILAR_B },
        { name: "forge-recover-http-via-browser", description: UNRELATED },
      ],
    });
    expect(nearest?.name).toBe("forge-rep-exec-read-edit");
    expect(nearest?.similarity).toBeGreaterThan(0.5);
  });

  it("returns undefined when everything is below threshold", () => {
    expect(
      findNearestNeighbor({
        description: SIMILAR_A,
        neighbors: [{ name: "other", description: UNRELATED }],
      }),
    ).toBeUndefined();
  });
});

describe("buildDifferentiatedDescription", () => {
  it("appends the supports/differs-from/excludes triple", () => {
    const result = buildDifferentiatedDescription({
      name: "forge-rep-exec-read-write",
      description: SIMILAR_A,
      neighbors: [{ name: "forge-rep-exec-read-edit", description: SIMILAR_B }],
    });
    expect(result.nearest?.name).toBe("forge-rep-exec-read-edit");
    expect(result.description).toContain("Skill++: supports");
    expect(result.description).toContain("differs from forge-rep-exec-read-edit");
    expect(result.description).toContain("excludes write");
    expect(result.description).toContain("% description overlap");
    expect(result.description.startsWith(SIMILAR_A)).toBe(true);
  });

  it("excludes self from neighbors and leaves lone skills unchanged", () => {
    const result = buildDifferentiatedDescription({
      name: "solo",
      description: SIMILAR_A,
      neighbors: [{ name: "solo", description: SIMILAR_A }],
    });
    expect(result.description).toBe(SIMILAR_A);
    expect(result.nearest).toBeUndefined();
  });
});

describe("differentiatePromotedSkillDescription (in place)", () => {
  let stateDir: string;

  beforeAll(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "skill-forge-diff-"));
    const skillsRoot = path.join(stateDir, "skill-forge", "skills");
    await fsp.mkdir(path.join(skillsRoot, "forge-rep-exec-read-edit"), { recursive: true });
    await fsp.mkdir(path.join(skillsRoot, "forge-rep-exec-read-write"), { recursive: true });
    await fsp.writeFile(
      path.join(skillsRoot, "forge-rep-exec-read-edit", "SKILL.md"),
      `---\nname: forge-rep-exec-read-edit\ndescription: ${SIMILAR_B}\n---\n\nbody\n`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(skillsRoot, "forge-rep-exec-read-write", "SKILL.md"),
      `---\nname: forge-rep-exec-read-write\ndescription: ${SIMILAR_A}\n---\n\nbody\n`,
      "utf8",
    );
  });

  afterAll(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("rewrites the promoted SKILL.md description with the triple", async () => {
    const result = await differentiatePromotedSkillDescription({
      name: "forge-rep-exec-read-write",
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    });
    expect(result?.nearest?.name).toBe("forge-rep-exec-read-edit");
    const rewritten = await fsp.readFile(
      path.join(stateDir, "skill-forge", "skills", "forge-rep-exec-read-write", "SKILL.md"),
      "utf8",
    );
    const description = parseSkillDescription(rewritten);
    expect(description).toContain("differs from forge-rep-exec-read-edit");
    expect(description).toContain(SIMILAR_A.slice(0, 20));
    // The sibling stays untouched.
    const sibling = await fsp.readFile(
      path.join(stateDir, "skill-forge", "skills", "forge-rep-exec-read-edit", "SKILL.md"),
      "utf8",
    );
    expect(parseSkillDescription(sibling)).toBe(SIMILAR_B);
  });

  it("returns undefined when the skill dir does not exist", async () => {
    expect(
      await differentiatePromotedSkillDescription({
        name: "no-such-skill",
        env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
      }),
    ).toBeUndefined();
  });
});
