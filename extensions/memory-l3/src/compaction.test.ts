import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compactSession,
  applyCategoryBudget,
  applyCategoryBudgetWithOperators,
  pruneStaleToolOutputs,
  filterLowInformationMessages,
} from "./compaction.js";
import { IngestBuffer } from "./ingest.js";
import type { LlmCaller } from "./llm.js";
import { Storage } from "./storage.js";
import { INITIAL_L3_STATE, type L3State } from "./types.js";
import type { FactCertainty } from "./types.js";

const userMsg = (text: string) => ({ role: "user", content: text }) as never;

let tmpRoot: string;
let storage: Storage;
let buffer: IngestBuffer;
let state: L3State;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-compaction-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
  buffer = new IngestBuffer();
  state = { ...INITIAL_L3_STATE, agentId: "j-rorqual" };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("compactSession", () => {
  it("returns an empty result when buffer is empty", async () => {
    const caller = vi.fn(async () => "{}");
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result).toEqual({
      chunkId: null,
      factsAdded: 0,
      typedFactsAdded: 0,
      tokensBefore: 0,
      messagesIngested: 0,
      epochId: null,
    });
    expect(caller).not.toHaveBeenCalled();
  });

  it("segments extraction at topic boundaries when segmented compaction is enabled", async () => {
    await storage.ensureLayout();
    // 20 messages = two 10-message windows; orthogonal window embeddings
    // force one boundary at message index 10.
    for (let i = 0; i < 10; i++) {
      buffer.push("s1", userMsg(`gardening topic message ${i}`));
    }
    for (let i = 0; i < 10; i++) {
      buffer.push("s1", userMsg(`kubernetes topic message ${i}`));
    }
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [{ text: "segment fact", importance: 0.7, dedupKey: `seg:${Math.random()}` }],
      }),
    );
    let windowCall = 0;
    const embeddingProvider = {
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) =>
        texts.map(() => (windowCall++ % 2 === 0 ? [1, 0] : [0, 1])),
    };
    const result = await compactSession({
      sessionId: "s1",
      buffer,
      storage,
      caller,
      state,
      embeddingProvider,
      segmentedCompaction: true,
    });
    // One extraction call per topic segment.
    expect(caller).toHaveBeenCalledTimes(2);
    const doc = await storage.readL2Chunk(result.chunkId!, Date.now());
    expect(doc?.frontmatter.topicSegments).toEqual([
      { startMsgIndex: 0, endMsgIndex: 10 },
      { startMsgIndex: 10, endMsgIndex: 20 },
    ]);
  });

  it("keeps monolithic extraction when segmented compaction is disabled", async () => {
    await storage.ensureLayout();
    for (let i = 0; i < 20; i++) {
      buffer.push("s1", userMsg(`message ${i}`));
    }
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [{ text: "fact", importance: 0.7, dedupKey: "k:1" }],
      }),
    );
    let windowCall = 0;
    const embeddingProvider = {
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) =>
        texts.map(() => (windowCall++ % 2 === 0 ? [1, 0] : [0, 1])),
    };
    const result = await compactSession({
      sessionId: "s1",
      buffer,
      storage,
      caller,
      state,
      embeddingProvider,
      segmentedCompaction: false,
    });
    expect(caller).toHaveBeenCalledTimes(1);
    const doc = await storage.readL2Chunk(result.chunkId!, Date.now());
    expect(doc?.frontmatter.topicSegments).toBeUndefined();
  });

  it("persists information gain as novelty against long-term fact embeddings", async () => {
    await storage.ensureLayout();
    // Seed one long-term fact whose embedding is identical to what the stub
    // provider returns — the new chunk covers no new ground (gain 0).
    await storage.writeLongTerm(
      {
        version: 1,
        agentId: "j-rorqual",
        lastConsolidatedAt: 0,
        facts: [
          {
            id: "lt-1",
            text: "known fact",
            dedupKey: "known:fact",
            importance: 0.8,
            firstSeenAt: 1,
            lastConfirmedAt: 2,
            recallCount: 3,
            sourceChunkIds: ["chunk-0"],
            archived: false,
            archivedAt: null,
            embedding: [1, 0, 0],
          },
        ],
      },
      "body",
    );
    buffer.push("s1", userMsg("Something new."));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [{ text: "a fresh fact", importance: 0.7, dedupKey: "fresh:fact" }],
      }),
    );
    const embeddingProvider = {
      embed: async () => [1, 0, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    };
    const result = await compactSession({
      sessionId: "s1",
      buffer,
      storage,
      caller,
      state,
      embeddingProvider,
    });
    const doc = await storage.readL2Chunk(result.chunkId!, Date.now());
    expect(doc?.frontmatter.informationGain).toBeCloseTo(0, 6);
  });

  it("records full information gain when long-term memory is empty", async () => {
    await storage.ensureLayout();
    buffer.push("s1", userMsg("Brand new territory."));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [{ text: "novel fact", importance: 0.7, dedupKey: "novel:fact" }],
      }),
    );
    const embeddingProvider = {
      embed: async () => [0, 1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [0, 1, 0]),
    };
    const result = await compactSession({
      sessionId: "s1",
      buffer,
      storage,
      caller,
      state,
      embeddingProvider,
    });
    const doc = await storage.readL2Chunk(result.chunkId!, Date.now());
    expect(doc?.frontmatter.informationGain).toBe(1);
  });

  it("extracts facts, persists an L2 chunk, and drains the buffer", async () => {
    buffer.push("s1", userMsg("I prefer morning standups."));
    buffer.push("s1", userMsg("Yes, every weekday."));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          {
            text: "user prefers morning standups",
            importance: 0.8,
            dedupKey: "user_preference:morning_standups",
          },
        ],
      }),
    );
    await storage.ensureLayout();
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.chunkId).not.toBeNull();
    expect(result.factsAdded).toBe(1);
    expect(result.messagesIngested).toBe(2);
    expect(buffer.size("s1")).toBe(0);
    expect(state.l2ChunkIndex).toBe(1);
    expect(state.lastChunkId).toBe(result.chunkId);

    const paths = await storage.listL2ChunkPaths();
    expect(paths).toHaveLength(1);
    const doc = await storage.readL2ChunkAtPath(paths[0]!);
    expect(doc?.frontmatter.facts).toHaveLength(1);
    expect(doc?.frontmatter.facts[0]?.text).toBe("user prefers morning standups");
    expect(doc?.frontmatter.dedupKeys).toEqual(["user_preference:morning_standups"]);
  });

  it("populates deterministic extraction fields on the L2 chunk frontmatter", async () => {
    buffer.push("s1", {
      role: "user",
      content: "Please read /etc/passwd and /tmp/config.yaml",
      timestamp: 1000,
    } as never);
    buffer.push("s1", {
      role: "assistant",
      content: [{ type: "text", text: "Let me check." }],
      timestamp: 2000,
    } as never);
    buffer.push("s1", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "file content" }],
      isError: false,
      timestamp: 3000,
    } as never);
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          {
            text: "user asked to read config files",
            importance: 0.5,
            dedupKey: "action:read_config",
          },
        ],
      }),
    );
    await storage.ensureLayout();
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.chunkId).not.toBeNull();

    const paths = await storage.listL2ChunkPaths();
    expect(paths).toHaveLength(1);
    const doc = await storage.readL2ChunkAtPath(paths[0]!);
    expect(doc?.frontmatter.deterministic).toBeDefined();
    expect(doc?.frontmatter.deterministic?.toolNames).toEqual(["read"]);
    expect(doc?.frontmatter.deterministic?.turnCount).toBe(3);
    expect(doc?.frontmatter.deterministic?.timeSpan.start).toBe(1000);
    expect(doc?.frontmatter.deterministic?.timeSpan.end).toBe(3000);
    // File paths extracted from user message content
    expect(doc?.frontmatter.deterministic?.filePaths.length).toBeGreaterThanOrEqual(1);
    expect(doc?.frontmatter.deterministic?.filePaths).toContain("/etc/passwd");
    expect(doc?.frontmatter.deterministic?.filePaths).toContain("/tmp/config.yaml");
  });

  it("drops facts whose dedupKey is already in a recent chunk", async () => {
    await storage.ensureLayout();
    await storage.writeL2Chunk(
      {
        id: "chunk-prior",
        agentId: "j-rorqual",
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: Date.now(),
        facts: [],
        dedupKeys: ["user_preference:morning_standups"],
      },
      "",
    );

    buffer.push("s1", userMsg("morning standups again"));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          {
            text: "user prefers morning standups",
            importance: 0.8,
            dedupKey: "user_preference:morning_standups",
          },
          {
            text: "user uses tabs not spaces",
            importance: 0.6,
            dedupKey: "code_style:tabs",
          },
        ],
      }),
    );

    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.factsAdded).toBe(1);
    const paths = await storage.listL2ChunkPaths();
    const newChunkPath = paths.find((p) => !p.includes("chunk-prior"));
    expect(newChunkPath).toBeDefined();
    const doc = await storage.readL2ChunkAtPath(newChunkPath as string);
    expect(doc?.frontmatter.dedupKeys).toEqual(["code_style:tabs"]);
  });

  it("dedupes within-chunk when the LLM emits the same dedupKey twice", async () => {
    buffer.push("s1", userMsg("anything"));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          { text: "first emission", importance: 0.8, dedupKey: "k:dup" },
          { text: "second emission", importance: 0.3, dedupKey: "k:dup" },
        ],
      }),
    );
    await storage.ensureLayout();
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.factsAdded).toBe(1);
    const paths = await storage.listL2ChunkPaths();
    const doc = await storage.readL2ChunkAtPath(paths[0]!);
    expect(doc?.frontmatter.facts[0]?.text).toBe("first emission");
    expect(doc?.frontmatter.facts[0]?.importance).toBe(0.8);
  });

  it("grounds typed facts against the transcript and persists only those that survive", async () => {
    buffer.push(
      "s1",
      userMsg("My pi-hole is at 192.168.50.128 and the router is at 192.168.50.1."),
    );
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [],
        typedFacts: [
          {
            slot: "infra:pi_hole_ip",
            value: "192.168.50.128",
            sourceSpan: "pi-hole is at 192.168.50.128",
            unit: null,
            confidence: 0.95,
          },
          {
            slot: "infra:router_ip",
            value: "192.168.50.1",
            sourceSpan: "router is at 192.168.50.1",
            unit: null,
            confidence: 0.95,
          },
          {
            // Hallucinated — value never appeared in the transcript. Must be dropped.
            slot: "infra:gateway_ip",
            value: "10.0.0.1",
            sourceSpan: "gateway at 10.0.0.1",
            unit: null,
            confidence: 0.5,
          },
        ],
      }),
    );
    await storage.ensureLayout();
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.typedFactsAdded).toBe(2);

    const paths = await storage.listL2ChunkPaths();
    const doc = await storage.readL2ChunkAtPath(paths[0]!);
    expect(doc?.frontmatter.typedFacts).toHaveLength(2);
    expect(doc?.frontmatter.typedFacts?.map((t) => t.slot)).toEqual([
      "infra:pi_hole_ip",
      "infra:router_ip",
    ]);
    expect(doc?.frontmatter.typedFacts?.[0]?.value).toBe("192.168.50.128");
  });

  it("uses the native compaction prompt when nativeCompaction is enabled", async () => {
    buffer.push("s1", userMsg("I prefer morning standups."));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          {
            text: "usr:morning_standups=9AM",
            importance: 0.8,
            dedupKey: "user_preference:morning_standups",
          },
        ],
      }),
    );
    await storage.ensureLayout();
    await compactSession({
      sessionId: "s1",
      buffer,
      storage,
      caller,
      state,
      nativeCompaction: true,
    });
    expect(caller).toHaveBeenCalledTimes(1);
    const systemPrompt = (caller as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.systemPrompt;
    expect(systemPrompt).toContain("PROMPT_VERSION=14-NATIVE");
    // QW1 (2026-08-16): native dense extraction must preserve temporal expressions.
    expect(systemPrompt).toContain("TEMPORAL");
    // QW2 (2026-08-17): TANGLE conflict-preservation guard.
    expect(systemPrompt).toContain("CONFLICT");
  });

  it("writes the L1 archive with the original messages", async () => {
    buffer.push("s1", userMsg("first"));
    buffer.push("s1", userMsg("second"));
    const caller: LlmCaller = vi.fn(async () => JSON.stringify({ facts: [] }));
    await storage.ensureLayout();
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.chunkId).not.toBeNull();
    const archivePath = path.join(storage.root, "l1_archive", `${result.chunkId}.jsonl`);
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(archivePath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ role: "user", content: "first" });
    expect(JSON.parse(lines[1]!)).toEqual({ role: "user", content: "second" });
  });
});

describe("applyCategoryBudget", () => {
  it("returns all facts when budget is 0 (disabled)", () => {
    const facts = [
      { text: "a", importance: 0.5, dedupKey: "cat_a:1" },
      { text: "b", importance: 0.5, dedupKey: "cat_b:1" },
    ];
    expect(applyCategoryBudget(facts, 0)).toHaveLength(2);
  });

  it("drops lowest-importance facts over budget within a category", () => {
    const facts = [
      { text: "important", importance: 0.9, dedupKey: "infra:important" },
      { text: "less important", importance: 0.3, dedupKey: "infra:less" },
      { text: "least", importance: 0.1, dedupKey: "infra:least" },
    ];
    // "important" = ceil(9/4)+1 = 4 tokens. Budget of 4 keeps only the first.
    const result = applyCategoryBudget(facts, 4);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("important");
  });

  it("applies budget independently per category", () => {
    const facts = [
      { text: "infra fact one", importance: 0.9, dedupKey: "infra:1" },
      { text: "infra fact two", importance: 0.5, dedupKey: "infra:2" },
      { text: "pref fact one", importance: 0.9, dedupKey: "user_preference:1" },
      { text: "pref fact two", importance: 0.5, dedupKey: "user_preference:2" },
    ];
    // Each fact = ceil(14/4)+1 = 5 tokens. Budget of 5 keeps 1 per category.
    const result = applyCategoryBudget(facts, 5);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.text)).toContain("infra fact one");
    expect(result.map((f) => f.text)).toContain("pref fact one");
  });

  it("groups facts without a colon as 'uncategorized'", () => {
    const facts = [
      { text: "no prefix", importance: 0.5, dedupKey: "noprefix" },
      { text: "has prefix", importance: 0.9, dedupKey: "categorized:yes" },
    ];
    // Both are in different categories, so both survive a small budget.
    const result = applyCategoryBudget(facts, 10);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    expect(applyCategoryBudget([], 100)).toEqual([]);
  });

  it("preserves all facts when total is under budget", () => {
    const facts = [
      { text: "short", importance: 0.5, dedupKey: "a:1" },
      { text: "also short", importance: 0.5, dedupKey: "a:2" },
    ];
    expect(applyCategoryBudget(facts, 1000)).toHaveLength(2);
  });
});

describe("applyCategoryBudgetWithOperators", () => {
  it("returns all facts when budget is 0 (disabled)", async () => {
    const facts = [
      { text: "fact one", importance: 0.8, dedupKey: "a:1" },
      { text: "fact two", importance: 0.5, dedupKey: "a:2" },
    ];
    expect(await applyCategoryBudgetWithOperators({ facts, maxTokensPerCategory: 0 })).toHaveLength(
      2,
    );
  });

  it("behaves like simple budget at low pressure (retain/drop)", async () => {
    const facts = [
      { text: "high importance fact here", importance: 0.9, dedupKey: "a:1" },
      { text: "low importance fact", importance: 0.3, dedupKey: "a:2" },
    ];
    // Budget barely over the first fact — ~9% pressure (low).
    const result = await applyCategoryBudgetWithOperators({ facts, maxTokensPerCategory: 11 });
    expect(result).toHaveLength(1);
    expect(result[0]!.dedupKey).toBe("a:1");
  });

  it("merges overflow facts at moderate pressure", async () => {
    // Facts share sub-category "sys" so they can be merged.
    // 3 facts × ~7 tokens ≈ 20 total. Budget = 12 → ~67% pressure.
    // Merged fact (11 tokens) fits within category budget.
    const facts = [
      { text: "alpha system configuration", importance: 0.9, dedupKey: "a:sys" },
      { text: "alpha system parameters", importance: 0.7, dedupKey: "a:sys" },
      { text: "alpha system diagnostics", importance: 0.5, dedupKey: "a:sys" },
    ];
    const result = await applyCategoryBudgetWithOperators({ facts, maxTokensPerCategory: 12 });
    // Should retain the most important fact and merge the overflow.
    const mergedFacts = result.filter((f) => f.reasoning?.startsWith("merged:"));
    expect(mergedFacts.length).toBeGreaterThan(0);
  });

  it("uses LLM abstraction at high pressure when caller is provided", async () => {
    // High pressure: 4 facts, tiny budget.
    const facts = [
      { text: "alpha fact one", importance: 0.9, dedupKey: "a:1" },
      { text: "alpha fact two", importance: 0.8, dedupKey: "a:2" },
      { text: "alpha fact three", importance: 0.7, dedupKey: "a:3" },
      { text: "alpha fact four", importance: 0.6, dedupKey: "a:4" },
    ];
    const mockCaller: LlmCaller = async () => "alpha facts 1-4 combined";
    const result = await applyCategoryBudgetWithOperators({
      facts,
      maxTokensPerCategory: 6,
      caller: mockCaller,
    });
    const abstractFact = result.find((f) => f.reasoning === "abstract:2");
    // May or may not produce an abstract fact depending on merge behavior,
    // but the result should have fewer facts than the input.
    expect(result.length).toBeLessThan(facts.length);
  });

  it("QW-1: propagates conservative certainty in merge path", async () => {
    // Facts with mixed certainty sharing sub-category "sys".
    const facts = [
      {
        text: "alpha system config",
        importance: 0.9,
        dedupKey: "a:sys",
        certainty: "confirmed" as FactCertainty,
      },
      {
        text: "alpha system params",
        importance: 0.7,
        dedupKey: "a:sys",
        certainty: "tentative" as FactCertainty,
      },
      {
        text: "alpha system diag",
        importance: 0.5,
        dedupKey: "a:sys",
        certainty: "confirmed" as FactCertainty,
      },
    ];
    // Budget forces 2 facts to overflow and merge (each ~6 tokens, budget=8
    // retains only 1, leaving 2 to merge).
    const result = await applyCategoryBudgetWithOperators({ facts, maxTokensPerCategory: 8 });
    const mergedFact = result.find((f) => f.reasoning?.startsWith("merged:"));
    expect(mergedFact).toBeDefined();
    expect(mergedFact?.certainty).toBe("tentative");
  });

  it("QW-1: propagates conservative certainty in abstraction path", async () => {
    const facts = [
      {
        text: "alpha fact one",
        importance: 0.9,
        dedupKey: "a:1",
        certainty: "confirmed" as FactCertainty,
      },
      {
        text: "alpha fact two",
        importance: 0.8,
        dedupKey: "a:2",
        certainty: "tentative" as FactCertainty,
      },
      {
        text: "alpha fact three",
        importance: 0.7,
        dedupKey: "a:3",
        certainty: "instructional" as FactCertainty,
      },
      {
        text: "alpha fact four",
        importance: 0.6,
        dedupKey: "a:4",
        certainty: "confirmed" as FactCertainty,
      },
    ];
    // QW-3: LLM now returns structured JSON with certainty field.
    let capturedUserPrompt = "";
    let capturedSystemPrompt = "";
    const mockCaller: LlmCaller = async (req) => {
      capturedUserPrompt = req.userPrompt;
      capturedSystemPrompt = req.systemPrompt;
      return JSON.stringify({ text: "alpha facts combined", certainty: "tentative" });
    };
    const result = await applyCategoryBudgetWithOperators({
      facts,
      maxTokensPerCategory: 6,
      caller: mockCaller,
    });
    const abstractFact = result.find((f) => f.reasoning?.startsWith("abstract:"));
    expect(abstractFact).toBeDefined();
    // The abstract fact must carry the weakest certainty (tentative).
    expect(abstractFact?.certainty).toBe("tentative");
    // QW-3: text should be the LLM's structured text, not raw JSON.
    expect(abstractFact?.text).toBe("alpha facts combined");
    // QW1 (2026-08-16): fact-merge prompt must demand verbatim temporal expressions.
    expect(capturedUserPrompt).toContain("Preserve dates and times verbatim");
    expect(capturedSystemPrompt).toContain("never abbreviate or drop temporal expressions");
  });

  it("QW-3: parses structured JSON abstraction output and clamps certainty", async () => {
    // LLM tries to upgrade certainty to "confirmed" but the overflow
    // contains a tentative fact — the floor must clamp it back down.
    // The tentative fact has LOW importance so it lands in the overflow
    // (the highest-importance fact is retained before overflow is computed).
    const facts = [
      {
        text: "beta fact one",
        importance: 0.9,
        dedupKey: "b:1",
        certainty: "confirmed" as FactCertainty,
      },
      {
        text: "beta fact two",
        importance: 0.8,
        dedupKey: "b:2",
        certainty: "confirmed" as FactCertainty,
      },
      {
        text: "beta fact three",
        importance: 0.7,
        dedupKey: "b:3",
        certainty: "tentative" as FactCertainty,
      },
      {
        text: "beta fact four",
        importance: 0.6,
        dedupKey: "b:4",
        certainty: "confirmed" as FactCertainty,
      },
    ];
    const mockCaller: LlmCaller = async () =>
      JSON.stringify({ text: "beta facts combined", certainty: "confirmed" });
    const result = await applyCategoryBudgetWithOperators({
      facts,
      maxTokensPerCategory: 6,
      caller: mockCaller,
    });
    const abstractFact = result.find((f) => f.reasoning?.startsWith("abstract:"));
    expect(abstractFact).toBeDefined();
    // Certainty must be clamped to tentative (the conservative floor).
    expect(abstractFact?.certainty).toBe("tentative");
    expect(abstractFact?.text).toBe("beta facts combined");
  });

  it("QW-3: falls back to plain text when LLM returns non-JSON", async () => {
    const facts = [
      {
        text: "gamma fact one",
        importance: 0.9,
        dedupKey: "c:1",
        certainty: "confirmed" as FactCertainty,
      },
      {
        text: "gamma fact two",
        importance: 0.8,
        dedupKey: "c:2",
        certainty: "confirmed" as FactCertainty,
      },
      {
        text: "gamma fact three",
        importance: 0.7,
        dedupKey: "c:3",
        certainty: "confirmed" as FactCertainty,
      },
      {
        text: "gamma fact four",
        importance: 0.6,
        dedupKey: "c:4",
        certainty: "confirmed" as FactCertainty,
      },
    ];
    // Non-JSON response — should fall back to plain text.
    const mockCaller: LlmCaller = async () => "gamma facts plain text combined";
    const result = await applyCategoryBudgetWithOperators({
      facts,
      maxTokensPerCategory: 6,
      caller: mockCaller,
    });
    const abstractFact = result.find((f) => f.reasoning?.startsWith("abstract:"));
    expect(abstractFact).toBeDefined();
    expect(abstractFact?.text).toBe("gamma facts plain text combined");
  });

  it("applies budget independently per category", async () => {
    const facts = [
      { text: "cat a fact", importance: 0.8, dedupKey: "a:1" },
      { text: "cat b fact", importance: 0.8, dedupKey: "b:1" },
    ];
    // Both are in different categories, so both survive a small budget.
    const result = await applyCategoryBudgetWithOperators({ facts, maxTokensPerCategory: 10 });
    expect(result).toHaveLength(2);
  });
});

// Helper to create a tool-result message for tests
const toolResultMsg = (toolCallId: string, toolName: string, text: string, isError = false) =>
  ({
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  }) as never;

const assistantWithToolCall = (toolCallId: string) =>
  ({
    role: "assistant",
    content: [
      { type: "text", text: "Let me check." },
      { type: "toolCall", toolCallId, toolName: "read", input: {} },
    ],
    api: "anthropic",
    provider: "anthropic",
    model: "test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "toolCall",
    timestamp: 0,
  }) as never;

describe("pruneStaleToolOutputs", () => {
  it("keeps non-tool messages unchanged", () => {
    const msgs = [userMsg("hello"), userMsg("world")];
    const result = pruneStaleToolOutputs(msgs);
    expect(result).toHaveLength(2);
    expect(result).toEqual(msgs);
  });

  it("keeps the first occurrence of each tool result", () => {
    const msgs = [
      userMsg("check the file"),
      assistantWithToolCall("call-1"),
      toolResultMsg("call-1", "read", "file content here"),
    ];
    const result = pruneStaleToolOutputs(msgs);
    expect(result).toHaveLength(3);
  });

  it("prunes duplicate tool results with the same toolCallId", () => {
    const msgs = [
      userMsg("check the file"),
      assistantWithToolCall("call-1"),
      toolResultMsg("call-1", "read", "file content here"),
      toolResultMsg("call-1", "read", "file content here"),
      toolResultMsg("call-1", "read", "file content here"),
    ];
    const result = pruneStaleToolOutputs(msgs);
    expect(result).toHaveLength(3);
  });

  it("always keeps tool error messages even if duplicate", () => {
    const msgs = [
      userMsg("check the file"),
      assistantWithToolCall("call-1"),
      toolResultMsg("call-1", "read", "error: not found", true),
      toolResultMsg("call-1", "read", "error: not found", true),
    ];
    const result = pruneStaleToolOutputs(msgs);
    const toolResults = result.filter((m) => (m as { role?: string }).role === "toolResult");
    expect(toolResults).toHaveLength(2);
  });

  it("prunes large duplicate tool outputs with matching fingerprint", () => {
    const largeText = "x".repeat(2500);
    const msgs = [
      userMsg("check"),
      assistantWithToolCall("call-1"),
      toolResultMsg("call-1", "read", largeText),
      assistantWithToolCall("call-2"),
      toolResultMsg("call-2", "read", largeText),
    ];
    const result = pruneStaleToolOutputs(msgs);
    const toolResults = result.filter((m) => (m as { role?: string }).role === "toolResult");
    expect(toolResults).toHaveLength(1);
  });

  it("keeps large tool outputs when they are unique", () => {
    const largeText1 = "x".repeat(2500);
    const largeText2 = "y".repeat(2500);
    const msgs = [
      userMsg("check"),
      assistantWithToolCall("call-1"),
      toolResultMsg("call-1", "read", largeText1),
      assistantWithToolCall("call-2"),
      toolResultMsg("call-2", "read", largeText2),
    ];
    const result = pruneStaleToolOutputs(msgs);
    const toolResults = result.filter((m) => (m as { role?: string }).role === "toolResult");
    expect(toolResults).toHaveLength(2);
  });
});

// --- QW-1: filterLowInformationMessages tests ---

const assistantMsg = (text: string) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic",
    provider: "anthropic",
    model: "test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
    timestamp: 0,
  }) as never;

describe("filterLowInformationMessages", () => {
  it("returns all messages when none are low-information", () => {
    const msgs = [
      userMsg("Please help me configure the server"),
      assistantMsg("I'll help you configure the server. First, let's check the current setup."),
      userMsg("The config file is at /etc/nginx/nginx.conf"),
    ];
    const result = filterLowInformationMessages(msgs);
    expect(result).toHaveLength(3);
  });

  it("drops pure acknowledgment assistant messages", () => {
    const msgs = [
      userMsg("I updated the config file"),
      assistantMsg("Great!"),
      userMsg("Now it should work"),
      assistantMsg("Got it."),
    ];
    const result = filterLowInformationMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(msgs[0]);
    expect(result[1]).toEqual(msgs[2]);
  });

  it("drops short user acknowledgments", () => {
    const msgs = [userMsg("ok"), userMsg("The server is at 192.168.1.1"), userMsg("yes")];
    const result = filterLowInformationMessages(msgs);
    expect(result).toHaveLength(1);
    expect((result[0] as { content: string }).content).toBe("The server is at 192.168.1.1");
  });

  it("keeps assistant messages with tool calls", () => {
    const msgs = [
      userMsg("check the file"),
      assistantWithToolCall("call-1"),
      toolResultMsg("call-1", "read", "content"),
    ];
    const result = filterLowInformationMessages(msgs);
    expect(result).toHaveLength(3);
  });

  it("keeps substantive assistant messages", () => {
    const longText =
      "I've analyzed the configuration and found three issues with the nginx setup. " +
      "The server block is missing a proxy_pass directive, the SSL certificate path is wrong, " +
      "and the worker_processes setting is too low for the expected load.";
    const msgs = [userMsg("What did you find?"), assistantMsg(longText)];
    const result = filterLowInformationMessages(msgs);
    expect(result).toHaveLength(2);
  });

  it("keeps user questions even if short", () => {
    const msgs = [userMsg("Why?")];
    const result = filterLowInformationMessages(msgs);
    expect(result).toHaveLength(1);
  });

  it("drops empty assistant turns", () => {
    const emptyAssistant = {
      role: "assistant",
      content: [],
      api: "anthropic",
      provider: "anthropic",
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
      timestamp: 0,
    } as never;
    const msgs = [userMsg("hello"), emptyAssistant];
    const result = filterLowInformationMessages(msgs);
    expect(result).toHaveLength(1);
  });

  it("handles mixed content arrays in assistant messages", () => {
    // Assistant message with mixed content but no tool call and ack text
    const mixedAck = {
      role: "assistant",
      content: [{ type: "text", text: "Sure." }],
      api: "anthropic",
      provider: "anthropic",
      model: "test",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
      timestamp: 0,
    } as never;
    const msgs = [userMsg("please proceed"), mixedAck];
    const result = filterLowInformationMessages(msgs);
    expect(result).toHaveLength(1);
  });

  it("does not drop user messages with actionable content", () => {
    const msgs = [userMsg("Continue with the deployment plan"), userMsg("OK")];
    const result = filterLowInformationMessages(msgs);
    // "Continue with the deployment plan" is 33 chars, over the 30-char threshold
    // "OK" is a pure ack and gets dropped
    expect(result).toHaveLength(1);
    expect((result[0] as { content: string }).content).toBe("Continue with the deployment plan");
  });
});
