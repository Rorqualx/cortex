import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  publishToFacts,
  readSharedFacts,
  resolveConflicts,
  resolveSharedMemoryDir,
  writeSharedFacts,
  type SharedLongTermFact,
} from "./cross-context.js";
import type { LongTermFact } from "./types.js";

function makeLongTermFact(dedupKey: string, overrides: Partial<LongTermFact> = {}): LongTermFact {
  return {
    id: `lt-${dedupKey}`,
    text: `Fact: ${dedupKey}`,
    dedupKey,
    importance: 0.7,
    firstSeenAt: 1000,
    lastConfirmedAt: 2000,
    recallCount: 3,
    sourceChunkIds: ["chunk-001"],
    archived: false,
    archivedAt: null,
    ...overrides,
  };
}

function makeSharedFact(
  dedupKey: string,
  agentId: string,
  overrides: Partial<SharedLongTermFact> = {},
): SharedLongTermFact {
  return {
    ...makeLongTermFact(dedupKey),
    sourceAgentId: agentId,
    ...overrides,
  };
}

describe("cross-context", () => {
  const tmpBase = path.join(os.tmpdir(), `openclaw-cross-context-test-${process.pid}`);

  async function cleanup(): Promise<void> {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }

  describe("resolveSharedMemoryDir", () => {
    it("uses override when provided", () => {
      assert.strictEqual(resolveSharedMemoryDir("/custom/path"), "/custom/path");
    });

    it("falls back to homedir default", () => {
      const result = resolveSharedMemoryDir();
      assert.ok(result.endsWith(path.join(".openclaw", "shared-memory")));
    });
  });

  describe("readSharedFacts / writeSharedFacts", () => {
    it("returns empty array when store does not exist", async () => {
      const dir = path.join(tmpBase, "nonexistent");
      const facts = await readSharedFacts(dir);
      assert.deepStrictEqual(facts, []);
      await cleanup();
    });

    it("round-trips facts through the store", async () => {
      const dir = path.join(tmpBase, "roundtrip");
      const facts: SharedLongTermFact[] = [
        makeSharedFact("key:alpha", "agent-1"),
        makeSharedFact("key:beta", "agent-2"),
      ];
      await writeSharedFacts(facts, dir);
      const read = await readSharedFacts(dir);
      assert.strictEqual(read.length, 2);
      assert.strictEqual(read[0].dedupKey, "key:alpha");
      assert.strictEqual(read[0].sourceAgentId, "agent-1");
      assert.strictEqual(read[1].dedupKey, "key:beta");
      await cleanup();
    });
  });

  describe("resolveConflicts", () => {
    it("passes through single-agent facts unchanged", () => {
      const facts = [makeSharedFact("key:1", "agent-a"), makeSharedFact("key:2", "agent-a")];
      const resolved = resolveConflicts(facts);
      assert.strictEqual(resolved.length, 2);
      assert.strictEqual(resolved.filter((f) => f.archived).length, 0);
    });

    it("archives lower-importance duplicate from different agent", () => {
      const facts = [
        makeSharedFact("key:ip", "agent-a", { importance: 0.9 }),
        makeSharedFact("key:ip", "agent-b", { importance: 0.5 }),
      ];
      const resolved = resolveConflicts(facts);
      assert.strictEqual(resolved.length, 2);
      const active = resolved.filter((f) => !f.archived);
      const archived = resolved.filter((f) => f.archived);
      assert.strictEqual(active.length, 1);
      assert.strictEqual(archived.length, 1);
      assert.strictEqual(active[0].sourceAgentId, "agent-a");
    });

    it("uses lastConfirmedAt as tiebreaker when importance is equal", () => {
      const facts = [
        makeSharedFact("key:x", "agent-a", { importance: 0.8, lastConfirmedAt: 1000 }),
        makeSharedFact("key:x", "agent-b", { importance: 0.8, lastConfirmedAt: 2000 }),
      ];
      const resolved = resolveConflicts(facts);
      const active = resolved.find((f) => !f.archived);
      assert.strictEqual(active!.sourceAgentId, "agent-b");
    });
  });

  describe("publishToFacts", () => {
    it("publishes new facts to empty store", async () => {
      const dir = path.join(tmpBase, "publish-new");
      const facts = [makeLongTermFact("key:new1"), makeLongTermFact("key:new2")];
      const result = await publishToFacts("agent-1", facts, dir);
      assert.strictEqual(result.published, 2);
      const stored = await readSharedFacts(dir);
      assert.strictEqual(stored.length, 2);
      assert.strictEqual(stored[0].sourceAgentId, "agent-1");
      await cleanup();
    });

    it("updates existing facts from same agent", async () => {
      const dir = path.join(tmpBase, "publish-update");
      await publishToFacts("agent-1", [makeLongTermFact("key:addr", { text: "old address" })], dir);
      await publishToFacts(
        "agent-1",
        [makeLongTermFact("key:addr", { text: "new address", lastConfirmedAt: 3000 })],
        dir,
      );
      const stored = await readSharedFacts(dir);
      const active = stored.filter((f) => !f.archived);
      assert.strictEqual(active.length, 1);
      assert.strictEqual(active[0].text, "new address");
      await cleanup();
    });

    it("skips archived facts in input", async () => {
      const dir = path.join(tmpBase, "publish-archived");
      const facts = [
        makeLongTermFact("key:active"),
        makeLongTermFact("key:dead", { archived: true, archivedAt: 999 }),
      ];
      await publishToFacts("agent-1", facts, dir);
      const stored = await readSharedFacts(dir);
      const active = stored.filter((f) => !f.archived);
      assert.strictEqual(active.length, 1);
      assert.strictEqual(active[0].dedupKey, "key:active");
      await cleanup();
    });

    it("preserves concurrent publishes from different agents (no lost update)", async () => {
      // Regression: the prior JSON store did async read-then-write, so two
      // publishers racing through Promise.all could both read the empty store
      // and the second write would clobber the first. The SQLite path does
      // read-merge-write inside one BEGIN IMMEDIATE transaction, so both
      // agents' facts must survive.
      const dir = path.join(tmpBase, "publish-concurrent");
      await Promise.all([
        publishToFacts("agent-1", [makeLongTermFact("key:a", { text: "from agent-1" })], dir),
        publishToFacts("agent-2", [makeLongTermFact("key:b", { text: "from agent-2" })], dir),
      ]);
      const stored = await readSharedFacts(dir);
      const active = stored.filter((f) => !f.archived);
      assert.strictEqual(active.length, 2);
      const agents = new Set(active.map((f) => f.sourceAgentId));
      assert.ok(agents.has("agent-1"));
      assert.ok(agents.has("agent-2"));
      await cleanup();
    });
  });
});
