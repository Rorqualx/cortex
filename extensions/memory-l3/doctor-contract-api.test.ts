// memory-l3 doctor migration: legacy shared JSON store -> cross-agent SQLite.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  readSharedFacts,
  writeSharedFacts,
  type SharedLongTermFact,
  type SharedStore,
} from "./src/cross-context.js";
import { Storage } from "./src/storage.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("memory-l3", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function makeSharedFact(
  dedupKey: string,
  agentId: string,
  overrides: Partial<SharedLongTermFact> = {},
): SharedLongTermFact {
  return {
    id: `lt-${agentId}-${dedupKey}`,
    text: `Fact ${dedupKey}`,
    dedupKey,
    importance: 0.7,
    firstSeenAt: 1000,
    lastConfirmedAt: 2000,
    recallCount: 1,
    sourceChunkIds: [],
    archived: false,
    archivedAt: null,
    sourceAgentId: agentId,
    ...overrides,
  };
}

describe("memory-l3 doctor shared-store migration", () => {
  let rootDir = "";
  let sharedDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-l3-doctor-"));
    sharedDir = path.join(rootDir, "shared-memory");
    await fs.mkdir(sharedDir, { recursive: true });
    env = { ...process.env, OPENCLAW_SHARED_MEMORY_DIR: sharedDir };
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function migrationParams() {
    return {
      config: {} as OpenClawConfig,
      env,
      stateDir: path.join(rootDir, "state"),
      oauthDir: path.join(rootDir, "oauth"),
      context: createDoctorContext(env),
    };
  }

  function legacyPath(): string {
    return path.join(sharedDir, "longterm-shared.json");
  }

  async function writeLegacy(facts: SharedLongTermFact[]): Promise<void> {
    const store: SharedStore = { version: 1, facts, lastUpdatedAt: 123 };
    await fs.writeFile(legacyPath(), `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  it("detects nothing when the legacy JSON file is absent", async () => {
    expect(await stateMigrations[0].detectLegacyState(migrationParams())).toBeNull();
  });

  it("imports legacy JSON facts into the SQLite store and archives the source", async () => {
    await writeLegacy([makeSharedFact("k:a", "agent-1"), makeSharedFact("k:b", "agent-2")]);

    const preview = await stateMigrations[0].detectLegacyState(migrationParams());
    expect(preview?.preview).toHaveLength(1);

    const result = await stateMigrations[0].migrateLegacyState(migrationParams());
    expect(result.changes.some((c) => c.includes("2 fact(s)"))).toBe(true);

    const stored = await readSharedFacts(sharedDir);
    expect(stored.map((f) => f.dedupKey).toSorted()).toEqual(["k:a", "k:b"]);

    await expect(fs.stat(legacyPath())).rejects.toThrow();
    await expect(fs.stat(`${legacyPath()}.migrated`)).resolves.toBeTruthy();
  });

  it("is idempotent: re-running finds nothing to migrate", async () => {
    await writeLegacy([makeSharedFact("k:a", "agent-1")]);
    await stateMigrations[0].migrateLegacyState(migrationParams());

    const second = await stateMigrations[0].migrateLegacyState(migrationParams());
    expect(second.changes).toEqual([]);
    expect(await stateMigrations[0].detectLegacyState(migrationParams())).toBeNull();
  });

  it("skips import when the SQLite store already has rows", async () => {
    await writeSharedFacts([makeSharedFact("k:existing", "agent-9")], sharedDir);
    await writeLegacy([makeSharedFact("k:a", "agent-1")]);

    const result = await stateMigrations[0].migrateLegacyState(migrationParams());
    expect(result.changes).toEqual([]);
    expect(result.warnings.some((w) => w.includes("already has rows"))).toBe(true);
    // Legacy source is left in place when skipped.
    await expect(fs.stat(legacyPath())).resolves.toBeTruthy();
  });
});

describe("memory-l3 doctor per-agent tier migration", () => {
  let rootDir = "";
  let workspaceDir = "";
  let l3Root = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-l3-agent-doctor-"));
    workspaceDir = path.join(rootDir, "workspace");
    l3Root = path.join(workspaceDir, ".openclaw", "l3");
    env = { ...process.env };
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function migrationParams() {
    return {
      config: { agents: { list: [{ id: "main", workspace: workspaceDir }] } } as OpenClawConfig,
      env,
      stateDir: path.join(rootDir, "state"),
      oauthDir: path.join(rootDir, "oauth"),
      context: createDoctorContext(env),
    };
  }

  async function writeDoc(filePath: string, frontmatter: unknown, body: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}\n`,
      "utf8",
    );
  }

  async function seedLegacyRoot(): Promise<void> {
    await fs.mkdir(l3Root, { recursive: true });
    await fs.writeFile(
      path.join(l3Root, "state.json"),
      JSON.stringify({ version: 1, agentId: "main", l2ChunkIndex: 2 }),
      "utf8",
    );
    await writeDoc(
      path.join(l3Root, "longterm.md"),
      {
        version: 1,
        agentId: "main",
        lastConsolidatedAt: 5,
        facts: [
          {
            id: "lt-1",
            text: "tabs",
            dedupKey: "pref:tabs",
            importance: 0.9,
            firstSeenAt: 1,
            lastConfirmedAt: 2,
            recallCount: 1,
            sourceChunkIds: ["c1"],
            archived: false,
            archivedAt: null,
          },
        ],
      },
      "## pref:tabs\ntabs",
    );
    await writeDoc(
      path.join(l3Root, "longterm-typed.md"),
      {
        version: 1,
        agentId: "main",
        lastConsolidatedAt: 5,
        facts: [
          {
            id: "tt-1",
            slot: "infra:ip",
            value: "10.0.0.2",
            unit: null,
            confidence: 0.9,
            firstSeenAt: 1,
            lastConfirmedAt: 2,
            recallCount: 1,
            sourceChunkIds: ["c1"],
            history: [],
            archived: false,
            archivedAt: null,
          },
        ],
      },
      "## infra:ip\n10.0.0.2",
    );
    await writeDoc(
      path.join(l3Root, "l2", "2026-05-06", "c1.md"),
      {
        id: "c1",
        agentId: "main",
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: Date.parse("2026-05-06T00:00:00Z"),
        facts: [],
        dedupKeys: [],
      },
      "summary body",
    );
    await writeDoc(
      path.join(l3Root, "l3", "epoch-1.md"),
      {
        id: "epoch-1",
        agentId: "main",
        startChunkId: "c1",
        endChunkId: "c1",
        createdAt: Date.parse("2026-05-06T01:00:00Z"),
        representativeFacts: [],
      },
      "epoch digest",
    );
    await fs.mkdir(path.join(l3Root, "msg", "c1"), { recursive: true });
    await fs.writeFile(
      path.join(l3Root, "msg", "c1", "chunks.json"),
      JSON.stringify([
        {
          id: "m1",
          seq: 0,
          startMsgIndex: 0,
          endMsgIndex: 2,
          text: "hello world",
          embedding: [0.1, 0.2, 0.3],
          createdAt: 1,
          chunkId: "c1",
        },
      ]),
      "utf8",
    );
    await fs.writeFile(
      path.join(l3Root, "entities.json"),
      JSON.stringify([
        {
          id: "e1",
          name: "Pi",
          category: "host",
          aliases: ["pi"],
          firstSeenAt: 1,
          lastSeenAt: 2,
          mentionCount: 1,
          sourceChunkIds: ["c1"],
          attributes: {},
        },
      ]),
      "utf8",
    );
    await fs.writeFile(
      path.join(l3Root, "topic-links.json"),
      JSON.stringify([{ sourceChunkId: "c1", targetChunkId: "c0", similarity: 0.8, createdAt: 1 }]),
      "utf8",
    );
    await fs.writeFile(
      path.join(l3Root, "retrieval-signals.json"),
      JSON.stringify([{ factId: "lt-1", recallCount: 3, lastRecalledAt: 9, firstRecalledAt: 1 }]),
      "utf8",
    );
    await fs.writeFile(
      path.join(l3Root, "edges.json"),
      JSON.stringify([{ a: "pref:tabs", b: "pref:dark", weight: 2 }]),
      "utf8",
    );
  }

  it("detects nothing when no legacy L3 root exists", async () => {
    expect(await stateMigrations[1].detectLegacyState(migrationParams())).toBeNull();
  });

  it("imports legacy per-agent tiers into l3.sqlite and archives index files", async () => {
    await seedLegacyRoot();

    const preview = await stateMigrations[1].detectLegacyState(migrationParams());
    expect(preview?.preview).toHaveLength(1);

    const result = await stateMigrations[1].migrateLegacyState(migrationParams());
    expect(result.changes.some((c) => c.includes("l3.sqlite"))).toBe(true);

    const storage = new Storage(l3Root);
    try {
      // Every tier round-trips through the importer + Storage writers.
      expect((await storage.readState()).l2ChunkIndex).toBe(2);
      expect((await storage.readLongTerm()).facts[0].dedupKey).toBe("pref:tabs");
      expect((await storage.readLongTermTyped()).facts[0].slot).toBe("infra:ip");
      expect(await storage.listL2ChunkPaths()).toHaveLength(1);
      expect(await storage.listL3EpochPaths()).toHaveLength(1);
      const msgChunks = await storage.readMessageChunks("c1");
      expect(msgChunks).toHaveLength(1);
      expect(msgChunks[0].embedding).toEqual([0.1, 0.2, 0.3]);
      expect((await storage.readEntityIndex())[0].name).toBe("Pi");
      expect((await storage.readTopicLinks())[0].targetChunkId).toBe("c0");
      expect((await storage.readRetrievalSignals())[0].factId).toBe("lt-1");
      expect((await storage.readEdgeMap())[0]).toEqual({
        a: "pref:tabs",
        b: "pref:dark",
        weight: 2,
      });
    } finally {
      storage.close();
    }

    // DB-only index files are archived; the markdown tiers are re-exported.
    await expect(fs.stat(path.join(l3Root, "state.json"))).rejects.toThrow();
    await expect(fs.stat(`${path.join(l3Root, "state.json")}.migrated`)).resolves.toBeTruthy();
    await expect(fs.stat(path.join(l3Root, "entities.json"))).rejects.toThrow();
    await expect(fs.stat(path.join(l3Root, "longterm.md"))).resolves.toBeTruthy();
  });

  it("still imports legacy when the runtime wrote a chunk first (no orphaning)", async () => {
    // Deploy-runbook violation: the SQLite runtime ran and wrote a chunk before
    // `doctor --fix`. The migration must NOT skip (that would orphan the on-disk
    // memory permanently); it imports the legacy tiers anyway and warns.
    await seedLegacyRoot();
    const pre = new Storage(l3Root);
    try {
      await pre.writeL2Chunk(
        {
          id: "runtime-chunk",
          agentId: "main",
          startTurnIndex: 0,
          endTurnIndex: 1,
          createdAt: Date.now(),
          facts: [],
          dedupKeys: [],
        },
        "written by runtime before doctor",
      );
    } finally {
      pre.close();
    }

    const result = await stateMigrations[1].migrateLegacyState(migrationParams());
    expect(result.changes.some((c) => c.includes("l3.sqlite"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("already had chunks"))).toBe(true);

    const storage = new Storage(l3Root);
    try {
      // Legacy long-term memory is present (not orphaned); runtime chunk survives too.
      expect((await storage.readLongTerm()).facts[0].dedupKey).toBe("pref:tabs");
      const ids = (await storage.listL2ChunkPaths()).map((p) =>
        p.replace(/.*\//, "").replace(/\.md$/, ""),
      );
      expect(ids).toContain("c1");
      expect(ids).toContain("runtime-chunk");
    } finally {
      storage.close();
    }
  });

  it("is idempotent: re-running finds nothing (sentinel archived)", async () => {
    await seedLegacyRoot();
    await stateMigrations[1].migrateLegacyState(migrationParams());

    expect(await stateMigrations[1].detectLegacyState(migrationParams())).toBeNull();
    const second = await stateMigrations[1].migrateLegacyState(migrationParams());
    expect(second.changes).toEqual([]);
  });
});
