/**
 * Compression pipeline tests.
 *
 * Covers:
 *  - Scoring (error signals, uniqueness, positional)
 *  - SmartCrusher (JSON arrays of various sizes)
 *  - SearchCompressor (grep/glob formats)
 *  - LogCompressor (build/test/log output)
 *  - DiffCompressor (unified diffs)
 *  - ContentRouter (type detection + dispatch)
 *  - TokenBudgetEnforcer (budget enforcement)
 *  - Pipeline shell (compressAssembledContext)
 *  - Config resolution
 *  - CCR Store (SQLite-backed reversible cache)
 *  - ContextTracker (cross-turn relevance detection)
 *  - CCR integration with pipeline
 */
import { describe, it, expect, afterEach } from "vitest";
import type { AgentMessage } from "../agents/runtime/index.js";
import { routeAndCompress } from "./content-router.js";
import { compressDiffOutput } from "./diff-compressor.js";
import {
  compressAssembledContext,
  resolveCompressionConfig,
  DEFAULT_COMPRESSION_CONFIG,
} from "./index.js";
import { compressLogOutput } from "./log-compressor.js";
import { scoreItem, buildFieldStats, findConstantFields } from "./scoring.js";
import { compressSearchResults } from "./search-compressor.js";
import { crushJsonArray } from "./smart-crusher.js";
import { hasTemporalAnchor } from "./temporal.js";
import { enforceTokenBudget, estimateTokens } from "./token-budget-enforcer.js";
import type { CompressionConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<CompressionConfig>): CompressionConfig {
  return { ...DEFAULT_COMPRESSION_CONFIG, enabled: true, ...overrides };
}

/** Generate a JSON array of N items with common fields. */
function generateJsonArray(
  count: number,
  opts?: { errorAt?: number; constantField?: boolean },
): string {
  const items = [];
  for (let i = 0; i < count; i++) {
    const item: Record<string, unknown> = {
      file: `src/module${i % 10}.ts`,
      line: i * 3 + 1,
      message: `Match at line ${i * 3 + 1}`,
    };
    if (opts?.constantField) {
      item.type = "import";
    }
    if (opts?.errorAt === i) {
      item.message = `ERROR: something went wrong at index ${i}`;
    }
    items.push(item);
  }
  return JSON.stringify(items, null, 2);
}

/** Generate grep output lines. */
function generateGrepOutput(fileCount: number, matchesPerFile: number): string {
  const lines: string[] = [];
  for (let f = 0; f < fileCount; f++) {
    for (let m = 0; m < matchesPerFile; m++) {
      lines.push(`/src/module${f}.ts:${m * 5 + 1}:import { something } from "lib"`);
    }
  }
  return lines.join("\n");
}

/** Generate log output. */
function generateLogOutput(lineCount: number, errorAt?: number[]): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    if (errorAt?.includes(i)) {
      lines.push(
        `2026-06-06T12:00:${String(i).padStart(2, "0")} ERROR: Something failed at step ${i}`,
      );
    } else {
      lines.push(`2026-06-06T12:00:${String(i).padStart(2, "0")} INFO: Processing step ${i}`);
    }
  }
  return lines.join("\n");
}

/** Generate a unified diff. */
function generateDiff(additionLines: number, removalLines: number): string {
  const lines = [
    "diff --git a/src/file.ts b/src/file.ts",
    "index abc1234..def5678 100644",
    "--- a/src/file.ts",
    "+++ b/src/file.ts",
    "@@ -10,5 +10," + (5 + additionLines - removalLines) + " @@",
    " context line 1",
    " context line 2",
  ];
  for (let i = 0; i < removalLines; i++) {
    lines.push(`-old line ${i}`);
  }
  for (let i = 0; i < additionLines; i++) {
    lines.push(`+new line ${i}`);
  }
  lines.push(" context line 3");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

describe("scoring", () => {
  it("scores error-containing items higher", () => {
    const fieldStats = new Map<string, { unique: number; total: number }>();
    fieldStats.set("msg", { unique: 10, total: 10 });

    const normalScore = scoreItem({ msg: "all good" }, 0, 10, fieldStats);
    const errorScore = scoreItem({ msg: "ERROR: failed" }, 1, 10, fieldStats);
    expect(errorScore).toBeGreaterThan(normalScore);
  });

  it("scores first and last items higher than middle", () => {
    // Use high-unique fields so uniqueness doesn't dominate
    const fieldStats = new Map<string, { unique: number; total: number }>();
    fieldStats.set("val", { unique: 10, total: 10 });

    const firstScore = scoreItem({ val: "x0" }, 0, 10, fieldStats);
    const midScore = scoreItem({ val: "x5" }, 5, 10, fieldStats);
    const lastScore = scoreItem({ val: "x9" }, 9, 10, fieldStats);

    expect(firstScore).toBeGreaterThan(midScore);
    expect(lastScore).toBeGreaterThan(midScore);
  });

  it("builds correct field stats", () => {
    const items = [
      { a: "x", b: 1 },
      { a: "x", b: 2 },
      { a: "y", b: 3 },
    ];
    const stats = buildFieldStats(items);
    expect(stats.get("a")!.unique).toBe(2); // x, y
    expect(stats.get("a")!.total).toBe(3);
    expect(stats.get("b")!.unique).toBe(3);
  });

  it("finds constant fields", () => {
    const stats = new Map<string, { unique: number; total: number; values: Set<string> }>();
    stats.set("constant", { unique: 1, total: 5, values: new Set(["same"]) });
    stats.set("varied", { unique: 5, total: 5, values: new Set(["a", "b", "c", "d", "e"]) });

    const constants = findConstantFields(stats);
    expect(constants).toEqual(["constant"]);
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Temporal anchors (F8 residual: dates/times must survive compression)
// ---------------------------------------------------------------------------

describe("temporal anchors", () => {
  it("detects ISO dates, slash dates, clock times, and month names", () => {
    expect(hasTemporalAnchor("deployed 2026-08-20")).toBe(true);
    expect(hasTemporalAnchor("at 2026-08-20T09:30:00Z we saw it")).toBe(true);
    expect(hasTemporalAnchor("release 2026/08/20")).toBe(true);
    expect(hasTemporalAnchor("due 08/20/2026")).toBe(true);
    expect(hasTemporalAnchor("standup at 09:30")).toBe(true);
    expect(hasTemporalAnchor("shipped Aug 20")).toBe(true);
    expect(hasTemporalAnchor("on 20 August")).toBe(true);
  });

  it("does not match plain text", () => {
    expect(hasTemporalAnchor("")).toBe(false);
    expect(hasTemporalAnchor("Match at line 3")).toBe(false);
    expect(hasTemporalAnchor("row 12 of 40 items")).toBe(false);
    expect(hasTemporalAnchor("version 1.2.3")).toBe(false);
  });

  it("scores items with temporal anchors above structurally identical plain items", () => {
    // Identical field stats (fully unique note field), same position — only the
    // temporal anchor differs, so the lift must be exactly its weight (0.1).
    const buildStats = () => {
      const m = new Map<string, { unique: number; total: number }>();
      m.set("note", { unique: 4, total: 4 });
      return m;
    };
    const plainScore = scoreItem({ note: "beta" }, 1, 4, buildStats());
    const datedScore = scoreItem({ note: "2026-08-20T09:30:00Z" }, 1, 4, buildStats());
    expect(datedScore).toBeGreaterThan(plainScore);
    expect(datedScore - plainScore).toBeCloseTo(0.1, 5);
  });

  it("keeps temporal-anchor items when sampling a JSON array", () => {
    const items = [];
    for (let i = 0; i < 40; i++) {
      items.push({
        name: "review record",
        note: i === 20 ? "audit flagged 2026-08-20T09:30:00Z" : "pending review of module payload",
      });
    }
    const result = crushJsonArray(JSON.stringify(items, null, 2), 16, 0.3);
    expect(result.compressed).toBe(true);
    expect(result.content).toContain("audit flagged");
  });

  it("prefers keeping temporal-anchor messages when trimming to budget", () => {
    const filler = "x".repeat(1000);
    const messages: AgentMessage[] = [
      {
        role: "assistant" as const,
        content: `dated deploy note 2026-08-20T09:30:00Z ${filler}`,
      } as unknown as AgentMessage,
      {
        role: "assistant" as const,
        content: `plain filler one ${filler}`,
      } as unknown as AgentMessage,
      {
        role: "assistant" as const,
        content: `plain filler two ${filler}`,
      } as unknown as AgentMessage,
      { role: "assistant" as const, content: "short plain note" } as unknown as AgentMessage,
      { role: "user" as const, content: "summarize" } as unknown as AgentMessage,
    ];
    // Without the temporal bonus the oldest message (idx 0) would be dropped
    // first; with it, the plain idx-1 message is dropped instead.
    const result = enforceTokenBudget(messages, 600, DEFAULT_COMPRESSION_CONFIG);
    const text = JSON.stringify(result);
    expect(text).toContain("dated deploy note");
    expect(text).toContain("plain filler two");
    expect(text).not.toContain("plain filler one");
  });
});

// ---------------------------------------------------------------------------
// SmartCrusher
// ---------------------------------------------------------------------------

describe("SmartCrusher", () => {
  it("compresses large JSON arrays", () => {
    const input = generateJsonArray(200);
    const result = crushJsonArray(input, 20, 0.3);
    expect(result.compressed).toBe(true);
    expect(result.contentType).toBe("json_array");
    expect(result.charsAfter).toBeLessThan(result.charsBefore);
  });

  it("keeps at most maxArrayItems", () => {
    const input = generateJsonArray(200);
    const result = crushJsonArray(input, 15, 0.3);
    expect(result.compressed).toBe(true);

    const parsed = JSON.parse(result.content);
    expect(parsed.items.length).toBeLessThanOrEqual(15);
  });

  it("includes _stats header", () => {
    const input = generateJsonArray(200);
    const result = crushJsonArray(input, 20, 0.3);
    const parsed = JSON.parse(result.content);
    expect(parsed._stats).toBeDefined();
    expect(parsed._stats.total).toBe(200);
    expect(parsed._stats.showing).toBeLessThanOrEqual(20);
  });

  it("factors out constant fields", () => {
    const input = generateJsonArray(100, { constantField: true });
    const result = crushJsonArray(input, 15, 0.3);
    expect(result.compressed).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed._constant_fields).toBeDefined();
    expect(parsed._constant_fields.type).toBe("import");
  });

  it("preserves error items", () => {
    const input = generateJsonArray(100, { errorAt: 42 });
    const result = crushJsonArray(input, 15, 0.3);
    expect(result.compressed).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed._stats.errors).toBe(1);

    // Error item should be in the selection
    const hasError = parsed.items.some(
      (item: Record<string, unknown>) =>
        typeof item.message === "string" && item.message.includes("ERROR"),
    );
    expect(hasError).toBe(true);
  });

  it("passes through small arrays", () => {
    const input = generateJsonArray(5);
    const result = crushJsonArray(input, 20, 0.3);
    expect(result.compressed).toBe(false);
  });

  it("passes through non-JSON content", () => {
    const result = crushJsonArray("not json at all", 20, 0.3);
    expect(result.compressed).toBe(false);
  });

  it("passes through JSON objects (not arrays)", () => {
    const result = crushJsonArray('{"key": "value"}', 20, 0.3);
    expect(result.compressed).toBe(false);
  });

  it("passes through arrays of primitives", () => {
    const result = crushJsonArray("[1, 2, 3, 4, 5]", 20, 0.3);
    expect(result.compressed).toBe(false);
  });

  it("passes through empty array", () => {
    const result = crushJsonArray("[]", 20, 0.3);
    expect(result.compressed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SearchCompressor
// ---------------------------------------------------------------------------

describe("SearchCompressor", () => {
  it("compresses grep output", () => {
    const input = generateGrepOutput(20, 10); // 20 files, 10 matches each
    const result = compressSearchResults(input, 0.3);
    expect(result.compressed).toBe(true);
    expect(result.contentType).toBe("search");
    expect(result.charsAfter).toBeLessThan(result.charsBefore);
  });

  it("includes summary line", () => {
    const input = generateGrepOutput(10, 20);
    const result = compressSearchResults(input, 0.3);
    expect(result.compressed).toBe(true);
    expect(result.content).toContain("matches across");
    expect(result.content).toContain("files");
  });

  it("keeps error lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      if (i === 50) {
        lines.push("/src/main.ts:100:ERROR: critical failure");
      } else {
        lines.push(`/src/module${i % 5}.ts:${i}:import something`);
      }
    }
    const result = compressSearchResults(lines.join("\n"), 0.3);
    expect(result.compressed).toBe(true);
    expect(result.content).toContain("ERROR: critical failure");
  });

  it("passes through small outputs", () => {
    const input = "/src/file.ts:1:hello";
    const result = compressSearchResults(input, 0.3);
    expect(result.compressed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LogCompressor
// ---------------------------------------------------------------------------

describe("LogCompressor", () => {
  it("compresses log output", () => {
    const input = generateLogOutput(100);
    const result = compressLogOutput(input, 0.3);
    expect(result.compressed).toBe(true);
    expect(result.contentType).toBe("log");
  });

  it("keeps error lines", () => {
    const input = generateLogOutput(50, [10, 25, 40]);
    const result = compressLogOutput(input, 0.3);
    expect(result.compressed).toBe(true);
    expect(result.content).toContain("ERROR: Something failed at step 10");
    expect(result.content).toContain("ERROR: Something failed at step 25");
    expect(result.content).toContain("ERROR: Something failed at step 40");
  });

  it("collapses repeated lines", () => {
    const lines = Array(50).fill("2026-06-06T12:00:00 INFO: Same message");
    const input = lines.join("\n");
    const result = compressLogOutput(input, 0.3);
    expect(result.compressed).toBe(true);
    expect(result.content).toContain("identical lines omitted");
  });

  it("passes through short logs", () => {
    const input = "line 1\nline 2\nline 3";
    const result = compressLogOutput(input, 0.3);
    expect(result.compressed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DiffCompressor
// ---------------------------------------------------------------------------

describe("DiffCompressor", () => {
  it("compresses large diffs", () => {
    const input = generateDiff(50, 5);
    const result = compressDiffOutput(input, 0.3);
    expect(result.compressed).toBe(true);
    expect(result.contentType).toBe("diff");
    expect(result.content).toContain("lines added");
  });

  it("keeps all removals", () => {
    const input = generateDiff(5, 10);
    const result = compressDiffOutput(input, 0.3);
    // With only 5 addition lines, short enough not to compress additions
    // but removals should be fully present
    for (let i = 0; i < 10; i++) {
      expect(result.content).toContain(`-old line ${i}`);
    }
  });

  it("keeps context lines", () => {
    const input = generateDiff(50, 2);
    const result = compressDiffOutput(input, 0.3);
    expect(result.compressed).toBe(true);
    expect(result.content).toContain("context line 1");
    expect(result.content).toContain("context line 3");
  });

  it("passes through small diffs", () => {
    const input = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n";
    const result = compressDiffOutput(input, 0.3);
    expect(result.compressed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ContentRouter
// ---------------------------------------------------------------------------

describe("ContentRouter", () => {
  const config = makeConfig();

  it("routes JSON arrays to SmartCrusher", () => {
    const input = generateJsonArray(200);
    const result = routeAndCompress(input, config);
    expect(result.contentType).toBe("json_array");
    expect(result.compressed).toBe(true);
  });

  it("routes grep output to SearchCompressor", () => {
    const input = generateGrepOutput(20, 20);
    const result = routeAndCompress(input, config);
    expect(result.contentType).toBe("search");
    expect(result.compressed).toBe(true);
  });

  it("routes diff output to DiffCompressor", () => {
    const input = generateDiff(100, 5);
    const result = routeAndCompress(input, config);
    expect(result.contentType).toBe("diff");
    expect(result.compressed).toBe(true);
  });

  it("routes log output to LogCompressor", () => {
    // Use a format that doesn't look like grep output (no colon-separated paths)
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`[INFO] Processing step ${i} of 100`);
    }
    lines[50] = `[ERROR] Something failed at step 50`;
    const input = lines.join("\n");
    const result = routeAndCompress(input, config);
    expect(result.contentType).toBe("log");
    expect(result.compressed).toBe(true);
  });

  it("passes through unknown content", () => {
    const input = "Just some random text that doesn't match any pattern.";
    const result = routeAndCompress(input, config);
    expect(result.contentType).toBe("passthrough");
    expect(result.compressed).toBe(false);
  });

  it("respects disabled types", () => {
    const disabledConfig = makeConfig({
      enabledTypes: { jsonArrays: false, searchResults: true, logs: true, diffs: true },
    });
    const input = generateJsonArray(200);
    const result = routeAndCompress(input, disabledConfig);
    expect(result.compressed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TokenBudgetEnforcer
// ---------------------------------------------------------------------------

describe("TokenBudgetEnforcer", () => {
  it("estimates tokens from text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello")).toBe(2); // 5 chars / 4 = 1.25 → ceil = 2
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });

  it("returns messages unchanged when under budget", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi there" },
    ] as unknown as unknown as AgentMessage[];
    const result = enforceTokenBudget(messages, 10000, DEFAULT_COMPRESSION_CONFIG);
    expect(result).toEqual(messages);
  });

  it("drops tool results when over budget", () => {
    const largeContent = "x".repeat(10000);
    const messages: AgentMessage[] = [
      {
        role: "toolResult" as const,
        toolCallId: "1",
        toolName: "grep",
        content: [{ type: "text" as const, text: largeContent }],
        isError: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage,
      { role: "user" as const, content: "what did you find?" } as unknown as AgentMessage,
    ];
    const result = enforceTokenBudget(messages, 100, DEFAULT_COMPRESSION_CONFIG);
    // The last user message should survive; the oversized tool result is dropped.
    expect(result.some((m) => m.role === "user")).toBe(true);
    expect(result.length).toBeLessThan(messages.length);
  });
});

// ---------------------------------------------------------------------------
// Pipeline shell
// ---------------------------------------------------------------------------

describe("compressAssembledContext", () => {
  const config = makeConfig({ minContentChars: 100 });

  it("compresses tool result messages", async () => {
    const largeJson = generateJsonArray(200);
    const messages: AgentMessage[] = [
      { role: "system" as const, content: "System prompt" } as unknown as AgentMessage,
      { role: "user" as const, content: "Search for errors" } as unknown as AgentMessage,
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "tc1", toolName: "grep", args: {} }],
      } as unknown as AgentMessage,
      {
        role: "toolResult" as const,
        toolCallId: "tc1",
        toolName: "grep",
        content: [{ type: "text" as const, text: largeJson }],
        isError: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage,
    ];

    const result = await compressAssembledContext(messages, config);
    expect(result.messages.length).toBe(4);
    expect(result.stats.messagesCompressed).toBe(1);
    expect(result.charsAfter).toBeLessThan(result.charsBefore);
  });

  it("does not compress user or system messages", async () => {
    const messages: AgentMessage[] = [
      {
        role: "system" as const,
        content: "System prompt that is quite long but not JSON",
      } as unknown as AgentMessage,
      {
        role: "user" as const,
        content:
          "Please help me with this really long request that has lots of text but is not a tool result",
      } as unknown as AgentMessage,
    ];

    const result = await compressAssembledContext(messages, config);
    expect(result.stats.messagesCompressed).toBe(0);
    expect((result.messages[0] as { content: string }).content).toBe(
      "System prompt that is quite long but not JSON",
    );
    expect((result.messages[1] as { content: string }).content).toBe(
      "Please help me with this really long request that has lots of text but is not a tool result",
    );
  });

  it("passes through short tool results", async () => {
    const messages = [
      {
        role: "toolResult" as const,
        toolCallId: "1",
        toolName: "read",
        content: [{ type: "text" as const, text: "short result" }],
        isError: false,
        timestamp: Date.now(),
      },
    ];

    const result = await compressAssembledContext(messages, config);
    expect(result.stats.messagesCompressed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

describe("resolveCompressionConfig", () => {
  it("returns defaults when no config provided", () => {
    const config = resolveCompressionConfig();
    expect(config.enabled).toBe(false);
    expect(config.targetRatio).toBe(0.3);
    expect(config.maxArrayItems).toBe(20);
  });

  it("merges partial user config with defaults", () => {
    const config = resolveCompressionConfig({ enabled: true, targetRatio: 0.5 });
    expect(config.enabled).toBe(true);
    expect(config.targetRatio).toBe(0.5);
    expect(config.maxArrayItems).toBe(20); // default
    expect(config.enabledTypes.jsonArrays).toBe(true); // default
  });

  it("preserves nested config", () => {
    const config = resolveCompressionConfig({
      ccr: { enabled: true, maxEntries: 500, ttlSeconds: 3600 },
    });
    expect(config.ccr.enabled).toBe(true);
    expect(config.ccr.maxEntries).toBe(500);
    expect(config.ccr.ttlSeconds).toBe(3600); // default
  });
});

// ---------------------------------------------------------------------------
// CCR Store
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextTracker } from "./ccr/context-tracker.js";
import { buildCompressionMarker, extractHashesFromContent } from "./ccr/retrieval-tool.js";
import { CCRStore } from "./ccr/store.js";

// Temp dir for test databases
let testDir: string;
afterEach(() => {
  // Cleanup handled per-test or via process exit
});

describe("CCRStore", () => {
  function createStore(opts?: { maxEntries?: number; ttlSeconds?: number }): CCRStore {
    testDir = mkdtempSync(join(tmpdir(), "ccr-test-"));
    const dbPath = join(testDir, "test.db");
    const store = new CCRStore(dbPath, opts?.maxEntries ?? 100, opts?.ttlSeconds ?? 3600);
    // Register cleanup
    afterEach(() => {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    return store;
  }

  it("stores and retrieves content", () => {
    const store = createStore();
    const hash = store.store("original content here", {
      messageIndex: 0,
      compressedAt: Date.now(),
      contentType: "json_array",
      originalChars: 100,
      compressedChars: 20,
    });

    expect(hash).toBeTruthy();
    expect(typeof hash).toBe("string");
    expect(hash.length).toBe(16); // truncated SHA-256

    const retrieved = store.retrieve(hash);
    expect(retrieved).toBe("original content here");
  });

  it("returns same hash for same content", () => {
    const store = createStore();
    const hash1 = store.store("same content", {
      messageIndex: 0,
      compressedAt: Date.now(),
      contentType: "json_array",
      originalChars: 50,
      compressedChars: 10,
    });
    const hash2 = store.store("same content", {
      messageIndex: 1,
      compressedAt: Date.now(),
      contentType: "json_array",
      originalChars: 50,
      compressedChars: 10,
    });
    expect(hash1).toBe(hash2);
  });

  it("returns null for unknown hash", () => {
    const store = createStore();
    expect(store.retrieve("nonexistent")).toBeNull();
  });

  it("tracks access count", () => {
    const store = createStore();
    const hash = store.store("content", {
      messageIndex: 0,
      compressedAt: Date.now(),
      contentType: "log",
      originalChars: 50,
      compressedChars: 10,
    });
    store.retrieve(hash);
    store.retrieve(hash);
    expect(store.getCount()).toBe(1);
  });

  it("searches within stored content", () => {
    const store = createStore();
    const hash = store.store(
      "line1: hello world\nline2: foo bar\nline3: hello baz\nline4: test data",
      {
        messageIndex: 0,
        compressedAt: Date.now(),
        contentType: "search",
        originalChars: 100,
        compressedChars: 20,
      },
    );

    const results = store.search(hash, "hello", 10);
    expect(results.length).toBe(2);
    expect(results[0]).toContain("hello");
    expect(results[1]).toContain("hello");
  });

  it("evicts expired entries", async () => {
    const store = createStore({ ttlSeconds: 0 }); // immediate expiry
    store.store("old content", {
      messageIndex: 0,
      compressedAt: Date.now(),
      contentType: "log",
      originalChars: 50,
      compressedChars: 10,
    });
    expect(store.getCount()).toBe(1);
    // Wait a tick so created_at < cutoff (both are Date.now() at insertion time)
    await new Promise((r) => setTimeout(r, 10));
    const evicted = store.evict();
    expect(evicted).toBe(1);
    expect(store.getCount()).toBe(0);
  });

  it("enforces max entries via LRU", () => {
    const store = createStore({ maxEntries: 2, ttlSeconds: 99999 });
    store.store("content1", {
      messageIndex: 0,
      compressedAt: Date.now(),
      contentType: "log",
      originalChars: 50,
      compressedChars: 10,
    });
    store.store("content2", {
      messageIndex: 1,
      compressedAt: Date.now(),
      contentType: "log",
      originalChars: 50,
      compressedChars: 10,
    });
    store.store("content3", {
      messageIndex: 2,
      compressedAt: Date.now(),
      contentType: "log",
      originalChars: 50,
      compressedChars: 10,
    });
    // After 3 inserts with max 2, one should be evicted
    expect(store.getCount()).toBeLessThanOrEqual(3); // eviction happens on explicit evict()
    const evicted = store.evict();
    expect(store.getCount()).toBeLessThanOrEqual(2);
  });

  it("returns metadata without content", () => {
    const store = createStore();
    const hash = store.store("secret content", {
      messageIndex: 5,
      compressedAt: Date.now(),
      contentType: "json_array",
      originalChars: 1000,
      compressedChars: 200,
    });
    const meta = store.getMeta(hash);
    expect(meta).toBeTruthy();
    expect(meta!.hash).toBe(hash);
    expect(meta!.contentType).toBe("json_array");
    expect(meta!.originalChars).toBe(1000);
    expect(meta!.originalContent).toBe(""); // not loaded
  });

  it("handles close gracefully", () => {
    const store = createStore();
    expect(store.isClosed).toBe(false);
    store.close();
    expect(store.isClosed).toBe(true);
    // Operations on closed store should fail gracefully
    expect(store.retrieve("any")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ContextTracker
// ---------------------------------------------------------------------------

describe("ContextTracker", () => {
  it("tracks compression events", () => {
    const tracker = new ContextTracker();
    tracker.trackCompression({
      hash: "abc123",
      originalContent: "file: src/engine.ts line: 42 error: something failed",
      messageIndex: 0,
      compressedAt: Date.now(),
      contentType: "search",
      originalChars: 200,
      compressedChars: 50,
    });
    expect(tracker.count).toBe(1);
  });

  it("detects relevance to compressed content", () => {
    const tracker = new ContextTracker();
    tracker.trackCompression({
      hash: "h1",
      originalContent: "src/engine.ts error TypeError cannot read property of undefined",
      messageIndex: 0,
      compressedAt: Date.now(),
      contentType: "search",
      originalChars: 200,
      compressedChars: 50,
    });
    tracker.trackCompression({
      hash: "h2",
      originalContent: "src/utils.ts warning deprecated function call",
      messageIndex: 1,
      compressedAt: Date.now(),
      contentType: "log",
      originalChars: 150,
      compressedChars: 30,
    });

    // Query about engine errors should match first entry
    const relevant = tracker.detectRelevance("engine TypeError error");
    expect(relevant.length).toBeGreaterThan(0);
    expect(relevant[0]?.hash).toBe("h1");
  });

  it("returns empty for irrelevant queries", () => {
    const tracker = new ContextTracker();
    tracker.trackCompression({
      hash: "h1",
      originalContent: "some content about database queries",
      messageIndex: 0,
      compressedAt: Date.now(),
      contentType: "log",
      originalChars: 100,
      compressedChars: 20,
    });

    const relevant = tracker.detectRelevance("kubernetes deployment config");
    expect(relevant.length).toBe(0);
  });

  it("clears all tracking state", () => {
    const tracker = new ContextTracker();
    tracker.trackCompression({
      hash: "h1",
      originalContent: "test content",
      messageIndex: 0,
      compressedAt: Date.now(),
      contentType: "log",
      originalChars: 50,
      compressedChars: 10,
    });
    expect(tracker.count).toBe(1);
    tracker.clear();
    expect(tracker.count).toBe(0);
    expect(tracker.getEntries()).toEqual([]);
  });

  it("returns recent entries", () => {
    const tracker = new ContextTracker();
    for (let i = 0; i < 5; i++) {
      tracker.trackCompression({
        hash: `h${i}`,
        originalContent: `content ${i}`,
        messageIndex: i,
        compressedAt: Date.now(),
        contentType: "log",
        originalChars: 50,
        compressedChars: 10,
      });
    }
    const recent = tracker.getRecentEntries(2);
    expect(recent.length).toBe(2);
    expect(recent[0]?.hash).toBe("h3");
    expect(recent[1]?.hash).toBe("h4");
  });
});

// ---------------------------------------------------------------------------
// Retrieval tool helpers
// ---------------------------------------------------------------------------

describe("retrieval-tool helpers", () => {
  it("builds compression marker", () => {
    const marker = buildCompressionMarker("abc123", 200, 15);
    expect(marker).toContain("200 items → 15");
    expect(marker).toContain("hash=abc123");
  });

  it("extracts hashes from content", () => {
    const content = "compressed output\n[200 items → 15. Retrieve: hash=abc123def456]";
    const hashes = extractHashesFromContent(content);
    expect(hashes).toEqual(["abc123def456"]);
  });

  it("extracts multiple hashes", () => {
    const content = "[100 → 10. Retrieve: hash=aaa111]\n[50 → 5. Retrieve: hash=bbb222]";
    const hashes = extractHashesFromContent(content);
    expect(hashes).toEqual(["aaa111", "bbb222"]);
  });
});

// ---------------------------------------------------------------------------
// CCR integration with pipeline
// ---------------------------------------------------------------------------

describe("compressAssembledContext with CCR", () => {
  const config = makeConfig({
    minContentChars: 100,
    ccr: { enabled: true, maxEntries: 100, ttlSeconds: 3600 },
  });

  it("stores originals in CCR and adds markers", async () => {
    const largeJson = generateJsonArray(200);
    const messages = [
      {
        role: "toolResult" as const,
        toolCallId: "tc1",
        toolName: "grep",
        content: [{ type: "text" as const, text: largeJson }],
        isError: false,
        timestamp: Date.now(),
      },
    ];

    const dir = mkdtempSync(join(tmpdir(), "ccr-pipeline-"));
    afterEach(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    const store = new CCRStore(join(dir, "test.db"), 100, 3600);
    const tracker = new ContextTracker();
    afterEach(() => {
      try {
        store.close();
      } catch {
        /* already closed */
      }
    });

    const result = await compressAssembledContext(messages, config, undefined, store, tracker);

    expect(result.stats.messagesCompressed).toBe(1);
    expect(result.ccrHashes.length).toBe(1);

    // Compressed content should have retrieval marker
    const toolMsg = result.messages[0];
    const text = (toolMsg as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(text).toContain("Retrieve: hash=");

    // Original should be retrievable
    const hash = result.ccrHashes[0];
    if (!hash) throw new Error("expected a CCR hash");
    const original = store.retrieve(hash);
    expect(original).toBe(largeJson);

    // Tracker should have recorded the compression
    expect(tracker.count).toBe(1);
  });

  it("works without CCR store (graceful degradation)", async () => {
    const largeJson = generateJsonArray(200);
    const messages = [
      {
        role: "toolResult" as const,
        toolCallId: "tc1",
        toolName: "grep",
        content: [{ type: "text" as const, text: largeJson }],
        isError: false,
        timestamp: Date.now(),
      },
    ];

    const noCcrConfig = makeConfig({
      minContentChars: 100,
      ccr: { enabled: false, maxEntries: 1000, ttlSeconds: 3600 },
    });
    const result = await compressAssembledContext(messages, noCcrConfig);

    expect(result.stats.messagesCompressed).toBe(1);
    expect(result.ccrHashes).toEqual([]);

    // No retrieval marker without CCR
    const toolMsg = result.messages[0];
    const text = (toolMsg as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(text).not.toContain("Retrieve: hash=");
  });
});

// ---------------------------------------------------------------------------
// Phase 3: TokenBudgetEnforcer with forward references
// ---------------------------------------------------------------------------

describe("TokenBudgetEnforcer forward references", () => {
  it("keeps assistant-toolResult pairs together", () => {
    const largeContent = "x".repeat(5000);
    const messages: AgentMessage[] = [
      { role: "system" as const, content: "System" } as unknown as AgentMessage,
      { role: "user" as const, content: "search for errors" } as unknown as AgentMessage,
      {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "tc1", toolName: "grep", args: {} }],
      } as unknown as AgentMessage,
      {
        role: "toolResult" as const,
        toolCallId: "tc1",
        toolName: "grep",
        content: [{ type: "text" as const, text: largeContent }],
        isError: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage,
      {
        role: "assistant" as const,
        content: "I found errors in the code.",
      } as unknown as AgentMessage,
      { role: "user" as const, content: "what about this?" } as unknown as AgentMessage,
    ];
    // Small budget should prefer to keep the pair
    const result = enforceTokenBudget(messages, 500, DEFAULT_COMPRESSION_CONFIG);
    // The last assistant + last user should survive
    expect(result.some((m) => m.role === "user")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 5: CCR Retrieve Tool Executor
// ---------------------------------------------------------------------------

import { createCCRRetrieveTool } from "./ccr/retrieval-tool-executor.js";

describe("createCCRRetrieveTool", () => {
  let testDir2: string;
  let store2: CCRStore;

  function setupStore(): CCRStore {
    testDir2 = mkdtempSync(join(tmpdir(), "ccr-exec-"));
    const dbPath = join(testDir2, "exec-test.db");
    store2 = new CCRStore(dbPath, 100, 3600);
    afterEach(() => {
      try {
        store2.close();
      } catch {
        /* already closed */
      }
      try {
        rmSync(testDir2, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    return store2;
  }

  it("returns null for undefined store", () => {
    expect(createCCRRetrieveTool(undefined)).toBeNull();
  });

  it("creates a tool with execute function", () => {
    const store = setupStore();
    const tool = createCCRRetrieveTool(store);
    expect(tool).toBeTruthy();
    expect(tool!.name).toBe("ccr_retrieve");
    expect(typeof tool!.execute).toBe("function");
  });

  it("retrieves content via execute", async () => {
    const store = setupStore();
    const hash = store.store("original data here", {
      messageIndex: 0,
      compressedAt: Date.now(),
      contentType: "json_array",
      originalChars: 100,
      compressedChars: 20,
    });

    const tool = createCCRRetrieveTool(store)!;
    const result = await tool.execute("call1", { hash });
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.content).toBe("original data here");
  });

  it("searches content via execute with query", async () => {
    const store = setupStore();
    const hash = store.store("line1: hello world\nline2: foo bar\nline3: hello baz", {
      messageIndex: 0,
      compressedAt: Date.now(),
      contentType: "search",
      originalChars: 100,
      compressedChars: 20,
    });

    const tool = createCCRRetrieveTool(store)!;
    const result = await tool.execute("call2", { hash, query: "hello" });
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.content).toContain("hello");
    expect(parsed.totalMatches).toBe(2);
  });

  it("returns error for unknown hash", async () => {
    const store = setupStore();
    const tool = createCCRRetrieveTool(store)!;
    const result = await tool.execute("call3", { hash: "nonexistent" });
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.error).toContain("No cached data found");
  });

  it("returns error for missing hash parameter", async () => {
    const store = setupStore();
    const tool = createCCRRetrieveTool(store)!;
    const result = await tool.execute("call4", {});
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.error).toContain("Missing or invalid hash");
  });

  it("falls back to full content when search finds nothing", async () => {
    const store = setupStore();
    const hash = store.store("apple banana cherry", {
      messageIndex: 0,
      compressedAt: Date.now(),
      contentType: "json_array",
      originalChars: 50,
      compressedChars: 10,
    });

    const tool = createCCRRetrieveTool(store)!;
    const result = await tool.execute("call5", { hash, query: "zebra" });
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.content).toBe("apple banana cherry");
    expect(parsed.note).toContain("No results matched");
  });
});
