// G5: prove the procedural (skill-forge) tier is first-class in retrieval —
// a promoted skill surfaces in retrieveTopK results for a matching query.
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retrieveTopK } from "./retrieval.js";
import { Storage } from "./storage.js";

const NOW = Date.UTC(2026, 4, 7, 12, 0, 0);

const SKILL_MD = `---
name: forge-recover-bash-via-read-abc123
description: Recovery workflow: when bash fails, recover by reading the file directly.
---

## Tool sequence

1. \`exec\`
2. \`read\`
3. \`edit\`
`;

let tmpRoot: string;
let storage: Storage;
let skillForgeDir: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-procret-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
  skillForgeDir = path.join(tmpRoot, "skill-forge");
  const skillDir = path.join(skillForgeDir, "forge-recover-bash-via-read-abc123");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), SKILL_MD, "utf8");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("procedural retrieval tier (G5)", () => {
  // retrieveTopK early-returns with no L2 chunks, so seed one unrelated chunk.
  const seedChunk = (): Promise<string> =>
    storage.writeL2Chunk(
      {
        id: "chunk-1",
        agentId: "a",
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: NOW,
        facts: [
          {
            id: "f1",
            text: "weather was sunny",
            importance: 0.3,
            createdAt: NOW,
            dedupKey: "misc:x",
          },
        ],
        dedupKeys: ["misc:x"],
      },
      "body",
    );

  it("surfaces a promoted skill for a matching query when skillForgeDir is set", async () => {
    await seedChunk();
    const res = await retrieveTopK({
      query: "how do I recover when bash fails",
      storage,
      topK: 5,
      now: NOW,
      skillForgeDir,
    });
    const proc = res.facts.find((f) => f.tier === "procedural");
    expect(proc).toBeDefined();
    expect(proc?.fact.text.toLowerCase()).toContain("recover");
  });

  it("does not surface skills when skillForgeDir is omitted", async () => {
    await seedChunk();
    const res = await retrieveTopK({
      query: "how do I recover when bash fails",
      storage,
      topK: 5,
      now: NOW,
    });
    expect(res.facts.find((f) => f.tier === "procedural")).toBeUndefined();
  });
});
