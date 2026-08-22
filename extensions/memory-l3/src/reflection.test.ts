import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmCaller } from "./llm.js";
import { type ReflectionConfig, generateInsights, reflectAndStore } from "./reflection.js";
import { retrieveTopK } from "./retrieval.js";
import { Storage } from "./storage.js";
import type { LongTermFact } from "./types.js";

const NOW = Date.UTC(2026, 4, 7, 12, 0, 0);
let tmpRoot: string;
let storage: Storage;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-reflection-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const facts = [
  { dedupKey: "stack:ts", text: "User writes TypeScript daily." },
  { dedupKey: "stack:node", text: "User runs everything on Node." },
];

const proseFact = (dedupKey: string, text: string, importance: number): LongTermFact => ({
  id: `lt-${dedupKey}`,
  text,
  dedupKey,
  importance,
  firstSeenAt: NOW,
  lastConfirmedAt: NOW,
  recallCount: 2,
  sourceChunkIds: ["c1"],
  archived: false,
  archivedAt: null,
  supersededBy: null,
});

const seedLongterm = (fs: LongTermFact[]): Promise<string> =>
  storage.writeLongTerm({ version: 1, agentId: "a", lastConsolidatedAt: NOW, facts: fs }, "");

const enabled: ReflectionConfig = { enabled: true, maxFacts: 30, maxInsights: 5, maxStored: 50 };

describe("generateInsights", () => {
  it("instructs the reflector to preserve temporal expressions verbatim", async () => {
    const calls: Array<{ systemPrompt: string }> = [];
    const caller: LlmCaller = vi.fn(async (req) => {
      calls.push(req as { systemPrompt: string });
      return JSON.stringify({ insights: [] });
    });
    await generateInsights({ facts, caller, now: NOW, maxInsights: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.systemPrompt).toContain("Preserve dates and times verbatim");
    expect(calls[0]?.systemPrompt).toContain("temporal anchors drive later retrieval");
  });

  it("keeps provenance-grounded insights and drops hallucinated citations", async () => {
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        insights: [
          {
            text: "User is a TypeScript/Node developer.",
            sources: ["stack:ts", "stack:node"],
            importance: 0.8,
          },
          { text: "User loves Rust.", sources: ["stack:rust"], importance: 0.7 },
        ],
      }),
    );
    const out = await generateInsights({ facts, caller, now: NOW, maxInsights: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toContain("TypeScript/Node");
    expect(out[0]?.sources).toEqual(["stack:ts", "stack:node"]);
  });

  it("drops only the unverifiable citations, keeping grounded ones on a mixed insight", async () => {
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        insights: [{ text: "Mixed.", sources: ["stack:ts", "stack:ghost"], importance: 0.6 }],
      }),
    );
    const out = await generateInsights({ facts, caller, now: NOW, maxInsights: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]?.sources).toEqual(["stack:ts"]);
  });

  it("returns [] for fewer than two facts and never calls the LLM", async () => {
    const caller: LlmCaller = vi.fn(async () => "{}");
    const out = await generateInsights({
      facts: facts.slice(0, 1),
      caller,
      now: NOW,
      maxInsights: 5,
    });
    expect(out).toHaveLength(0);
    expect(caller).not.toHaveBeenCalled();
  });

  it("respects maxInsights", async () => {
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        insights: [
          { text: "a", sources: ["stack:ts"], importance: 0.6 },
          { text: "b", sources: ["stack:node"], importance: 0.6 },
          { text: "c", sources: ["stack:ts"], importance: 0.6 },
        ],
      }),
    );
    const out = await generateInsights({ facts, caller, now: NOW, maxInsights: 2 });
    expect(out).toHaveLength(2);
  });
});

describe("reflectAndStore", () => {
  const caller: LlmCaller = vi.fn(async () =>
    JSON.stringify({
      insights: [
        { text: "User is a TS/Node dev.", sources: ["stack:ts", "stack:node"], importance: 0.8 },
      ],
    }),
  );

  it("is a no-op when disabled (default config)", async () => {
    await seedLongterm([proseFact("stack:ts", "TS", 0.9), proseFact("stack:node", "Node", 0.9)]);
    const r = await reflectAndStore({ storage, caller, agentId: "a", now: NOW });
    expect(r.added).toBe(0);
    expect((await storage.readInsights()).insights).toHaveLength(0);
  });

  it("stores grounded insights when enabled and dedups on re-run", async () => {
    await seedLongterm([proseFact("stack:ts", "TS", 0.9), proseFact("stack:node", "Node", 0.9)]);
    const r1 = await reflectAndStore({ storage, caller, agentId: "a", now: NOW, config: enabled });
    expect(r1.added).toBe(1);
    const r2 = await reflectAndStore({
      storage,
      caller,
      agentId: "a",
      now: NOW + 1000,
      config: enabled,
    });
    expect(r2.added).toBe(0);
    expect((await storage.readInsights()).insights).toHaveLength(1);
  });
});

describe("insight retrieval tier", () => {
  it("surfaces a stored insight for a matching query", async () => {
    // retrieveTopK early-returns when no L2 chunks exist, so seed one unrelated chunk.
    await storage.writeL2Chunk(
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
    await storage.writeInsights({
      version: 1,
      agentId: "a",
      lastReflectedAt: NOW,
      insights: [
        {
          id: "ins-1",
          text: "The user develops in TypeScript and Node",
          sources: ["stack:ts"],
          importance: 0.9,
          createdAt: NOW,
        },
      ],
    });
    const res = await retrieveTopK({
      query: "what does the user develop in",
      storage,
      topK: 5,
      now: NOW,
    });
    const insight = res.facts.find((f) => f.tier === "insight");
    expect(insight).toBeDefined();
    expect(insight?.fact.text).toContain("TypeScript");
  });
});
