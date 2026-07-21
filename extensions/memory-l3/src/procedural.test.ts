import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  fsrsProceduralRetrievability,
  parseSkillMd,
  proceduralFactAsL2Fact,
  readPromotedSkills,
  resolveSkillForgeDir,
  type ProceduralFact,
} from "./procedural.js";

const SAMPLE_SKILL_MD = `---
name: forge-recover-bash-via-read-abc123
description: Recovery workflow: when bash fails, recover by reading the file directly.
---

# Recovery Workflow

<!-- TODO(skill-forge): replace heuristic body with LLM-distilled prose -->

## Tool sequence

1. \`exec\`
2. \`read\`
3. \`edit\`

## When this triggers

\`exec\` failed; recovery succeeded by calling \`read\`.
`;

const SAMPLE_SKILL_NO_TOOLS = `---
name: forge-explicit-xyz789
description: User-tagged workflow for deployment.
---

# User-Tagged Workflow

No tool calls captured.
`;

describe("procedural", () => {
  const tmpBase = path.join(os.tmpdir(), `openclaw-procedural-test-${process.pid}`);

  async function cleanup(): Promise<void> {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }

  describe("resolveSkillForgeDir", () => {
    it("uses override when provided", () => {
      assert.strictEqual(resolveSkillForgeDir("/custom/skills"), "/custom/skills");
    });

    it("falls back to homedir default", () => {
      const result = resolveSkillForgeDir();
      assert.ok(result.includes("skill-forge"));
    });
  });

  describe("parseSkillMd", () => {
    it("parses a valid skill with tools", () => {
      const result = parseSkillMd(SAMPLE_SKILL_MD);
      assert.ok(result);
      assert.strictEqual(result.name, "forge-recover-bash-via-read-abc123");
      assert.ok(result.description.includes("bash fails"));
      assert.strictEqual(result.toolSequence.length, 3);
      assert.strictEqual(result.toolSequence[0], "exec");
      assert.strictEqual(result.lane, "error-recovery");
    });

    it("parses a skill with no tools", () => {
      const result = parseSkillMd(SAMPLE_SKILL_NO_TOOLS);
      assert.ok(result);
      assert.strictEqual(result.toolSequence.length, 0);
      assert.strictEqual(result.lane, "explicit");
    });

    it("detects tool-shape lane", () => {
      const md = `---
name: forge-rep-exec-edit-deadbeef
description: Repeated exec+edit pattern
---

## Tool sequence

1. \`exec\`
2. \`edit\`
`;
      const result = parseSkillMd(md);
      assert.strictEqual(result!.lane, "tool-shape");
    });

    it("returns null for missing frontmatter", () => {
      assert.strictEqual(parseSkillMd("no frontmatter here"), null);
    });

    it("returns null for missing name", () => {
      assert.strictEqual(parseSkillMd("---\ndescription: test\n---\nbody"), null);
    });
  });

  describe("readPromotedSkills", () => {
    it("returns empty for nonexistent directory", async () => {
      const facts = await readPromotedSkills(path.join(tmpBase, "nonexistent"));
      assert.deepStrictEqual(facts, []);
    });

    it("reads skills from directory", async () => {
      const skillDir = path.join(tmpBase, "skills", "test-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), SAMPLE_SKILL_MD, "utf8");

      const facts = await readPromotedSkills(path.join(tmpBase, "skills"));
      assert.strictEqual(facts.length, 1);
      const skill = facts[0];
      assert.ok(skill);
      assert.strictEqual(skill.skillName, "forge-recover-bash-via-read-abc123");
      assert.strictEqual(skill.toolSequence.length, 3);
      assert.strictEqual(skill.lane, "error-recovery");
      assert.strictEqual(skill.usageCount, 0);
      await cleanup();
    });

    it("reads telemetry when present", async () => {
      const skillDir = path.join(tmpBase, "skills-tel", "tel-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), SAMPLE_SKILL_MD, "utf8");
      await fs.writeFile(
        path.join(skillDir, "telemetry.json"),
        JSON.stringify({ usageCount: 5, successCount: 4, lastUsedAt: 1234567890 }),
        "utf8",
      );

      const facts = await readPromotedSkills(path.join(tmpBase, "skills-tel"));
      const skill = facts[0];
      assert.ok(skill);
      assert.strictEqual(skill.usageCount, 5);
      assert.strictEqual(skill.successCount, 4);
      assert.strictEqual(skill.lastUsedAt, 1234567890);
      await cleanup();
    });

    it("skips malformed skills silently", async () => {
      const skillDir = path.join(tmpBase, "skills-malformed", "bad-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "not a valid skill", "utf8");

      const facts = await readPromotedSkills(path.join(tmpBase, "skills-malformed"));
      assert.strictEqual(facts.length, 0);
      await cleanup();
    });
  });

  describe("proceduralFactAsL2Fact", () => {
    it("converts with tools", () => {
      const pf: ProceduralFact = {
        id: "proc-test",
        skillName: "test-skill",
        lane: "error-recovery",
        triggerDescription: "When X fails, do Y",
        toolSequence: ["exec", "read", "edit"],
        usageCount: 3,
        successCount: 2,
        promotedAt: 1000,
        lastUsedAt: null,
      };
      const l2 = proceduralFactAsL2Fact(pf);
      assert.strictEqual(l2.text, "When X fails, do Y. Tools: exec → read → edit");
      assert.strictEqual(l2.importance, 0.8); // 0.6 + 0.1 * 2
      assert.strictEqual(l2.dedupKey, "procedural:test-skill");
      assert.strictEqual(l2.createdAt, 1000);
    });

    it("caps importance at 0.95", () => {
      const pf: ProceduralFact = {
        id: "proc-cap",
        skillName: "popular",
        lane: "tool-shape",
        triggerDescription: "Popular skill",
        toolSequence: [],
        usageCount: 100,
        successCount: 50,
        promotedAt: 1000,
        lastUsedAt: null,
      };
      const l2 = proceduralFactAsL2Fact(pf);
      assert.strictEqual(l2.importance, 0.95);
    });

    it("handles empty tool sequence", () => {
      const pf: ProceduralFact = {
        id: "proc-notools",
        skillName: "no-tools",
        lane: "explicit",
        triggerDescription: "Just a description",
        toolSequence: [],
        usageCount: 0,
        successCount: 0,
        promotedAt: 2000,
        lastUsedAt: null,
      };
      const l2 = proceduralFactAsL2Fact(pf);
      assert.strictEqual(l2.text, "Just a description");
    });
  });

  describe("fsrsProceduralRetrievability", () => {
    it("returns high retrievability for fresh, used skill", () => {
      const pf: ProceduralFact = {
        id: "proc-fresh",
        skillName: "fresh",
        lane: "tool-shape",
        triggerDescription: "Fresh skill",
        toolSequence: [],
        usageCount: 10,
        successCount: 8,
        promotedAt: Date.now() - 1000, // 1 second ago
        lastUsedAt: null,
      };
      const r = fsrsProceduralRetrievability(pf, Date.now());
      assert.ok(r > 0.99);
    });

    it("decays over time", () => {
      const pf: ProceduralFact = {
        id: "proc-old",
        skillName: "old",
        lane: "tool-shape",
        triggerDescription: "Old skill",
        toolSequence: [],
        usageCount: 1,
        successCount: 0,
        promotedAt: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days ago
        lastUsedAt: null,
      };
      const r = fsrsProceduralRetrievability(pf, Date.now());
      assert.ok(r < 0.5);
    });

    it("higher usage count means slower decay", () => {
      const now = Date.now();
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
      const lowUse: ProceduralFact = {
        id: "proc-low",
        skillName: "low",
        lane: "tool-shape",
        triggerDescription: "Low use",
        toolSequence: [],
        usageCount: 1,
        successCount: 0,
        promotedAt: thirtyDaysAgo,
        lastUsedAt: null,
      };
      const highUse: ProceduralFact = {
        id: "proc-high",
        skillName: "high",
        lane: "tool-shape",
        triggerDescription: "High use",
        toolSequence: [],
        usageCount: 20,
        successCount: 18,
        promotedAt: thirtyDaysAgo,
        lastUsedAt: null,
      };
      const lowR = fsrsProceduralRetrievability(lowUse, now);
      const highR = fsrsProceduralRetrievability(highUse, now);
      assert.ok(highR > lowR, `high=${highR} should be > low=${lowR}`);
    });
  });
});
