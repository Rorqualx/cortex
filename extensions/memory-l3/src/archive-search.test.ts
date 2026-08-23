import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchArchive } from "./archive-search.js";
import { Storage } from "./storage.js";

let tmpRoot: string;
let storage: Storage;
let archiveDir: string;

function writeArchive(chunkId: string, turns: unknown[]): void {
  const lines = turns.map((turn) => JSON.stringify(turn)).join("\n");
  writeFileSync(path.join(archiveDir, `${chunkId}.jsonl`), `${lines}\n`);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-archive-search-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
  archiveDir = path.join(storage.root, "l1_archive");
  mkdirSync(archiveDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

describe("searchArchive", () => {
  it("returns BM25-ranked hits with chunk context", async () => {
    await storage.ensureLayout();
    writeArchive("chunk-001", [
      { role: "user", content: "the gateway port is 4317 now", timestamp: NOW - 1000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "noted the port change" }],
        timestamp: NOW - 900,
      },
      { role: "user", content: "unrelated gardening talk", timestamp: NOW - 800 },
    ]);
    await storage.recordChunkSession("chunk-001", "sess-a", NOW - 1000);

    const result = await searchArchive({ storage, query: "gateway port 4317", now: NOW });
    expect(result.filesScanned).toBe(1);
    expect(result.turnsScanned).toBe(3);
    expect(result.turnsCapped).toBe(false);
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0]?.text).toContain("4317");
    expect(result.hits[0]?.chunkId).toBe("chunk-001");
    expect(result.hits[0]?.sessionId).toBe("sess-a");
    // Scores sorted descending.
    const scores = result.hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("searches assistant tool-call blocks", async () => {
    await storage.ensureLayout();
    writeArchive("chunk-002", [
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "/var/log/gateway.log" } },
        ],
        timestamp: NOW,
      },
    ]);
    const result = await searchArchive({ storage, query: "gateway.log", now: NOW });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.text).toContain("read");
  });

  it("applies temporal narrowing via message timestamps and chunk fallback", async () => {
    await storage.ensureLayout();
    writeArchive("chunk-old", [
      { role: "user", content: "kubernetes upgrade plan alpha", timestamp: NOW - 10_000 },
    ]);
    writeArchive("chunk-new", [
      // No message timestamp — falls back to chunk sidecar createdAt.
      { role: "user", content: "kubernetes upgrade plan beta" },
    ]);
    await storage.recordChunkSession("chunk-new", "sess-b", NOW - 100);

    const recentOnly = await searchArchive({
      storage,
      query: "kubernetes upgrade plan",
      after: NOW - 1000,
      now: NOW,
    });
    expect(recentOnly.hits.every((h) => h.chunkId === "chunk-new")).toBe(true);

    const oldOnly = await searchArchive({
      storage,
      query: "kubernetes upgrade plan",
      before: NOW - 5000,
      now: NOW,
    });
    expect(oldOnly.hits.every((h) => h.chunkId === "chunk-old")).toBe(true);
  });

  it("filters by session hint and skip list", async () => {
    await storage.ensureLayout();
    writeArchive("chunk-x", [{ role: "user", content: "router config dump", timestamp: NOW }]);
    writeArchive("chunk-y", [
      { role: "user", content: "router config dump again", timestamp: NOW },
    ]);
    await storage.recordChunkSession("chunk-x", "agent:main:session-alpha", NOW);
    await storage.recordChunkSession("chunk-y", "agent:main:session-beta", NOW);

    const hinted = await searchArchive({
      storage,
      query: "router config",
      sessionHint: "alpha",
      now: NOW,
    });
    expect(hinted.hits.every((h) => h.chunkId === "chunk-x")).toBe(true);

    const skipped = await searchArchive({
      storage,
      query: "router config",
      skipSessionIds: ["agent:main:session-alpha"],
      now: NOW,
    });
    expect(skipped.hits.every((h) => h.chunkId === "chunk-y")).toBe(true);
  });

  it("caps turns scanned (newest files first) and reports it", async () => {
    await storage.ensureLayout();
    writeArchive(
      "chunk-big",
      Array.from({ length: 30 }, (_, i) => ({
        role: "user",
        content: `filler turn ${i} lorem ipsum`,
        timestamp: NOW,
      })),
    );
    writeArchive("chunk-small", [{ role: "user", content: "needle filler turn", timestamp: NOW }]);
    // Make the small (target) file the newest by mtime.
    utimesSync(path.join(archiveDir, "chunk-small.jsonl"), new Date(), new Date(NOW));
    utimesSync(path.join(archiveDir, "chunk-big.jsonl"), new Date(), new Date(NOW - 50_000));

    const result = await searchArchive({ storage, query: "needle", maxTurns: 5, now: NOW });
    expect(result.turnsCapped).toBe(true);
    expect(result.turnsScanned).toBeLessThanOrEqual(5);
    // The newest file was scanned before the cap hit.
    expect(result.hits.some((h) => h.chunkId === "chunk-small")).toBe(true);
  });

  it("returns an empty result when the archive directory is missing", async () => {
    const result = await searchArchive({ storage, query: "anything", now: NOW });
    expect(result.hits).toEqual([]);
    expect(result.filesScanned).toBe(0);
  });

  it("re-parses a file after its mtime changes (cache invalidation)", async () => {
    await storage.ensureLayout();
    writeArchive("chunk-m", [{ role: "user", content: "first version text", timestamp: NOW }]);
    const before = await searchArchive({ storage, query: "zephyr unique marker", now: NOW });
    expect(before.hits).toEqual([]);
    // Append a turn and bump mtime — the parse cache must invalidate.
    writeFileSync(
      path.join(archiveDir, "chunk-m.jsonl"),
      `${JSON.stringify({ role: "user", content: "first version text", timestamp: NOW })}\n${JSON.stringify({ role: "user", content: "the zephyr unique marker appears here", timestamp: NOW })}\n`,
    );
    utimesSync(path.join(archiveDir, "chunk-m.jsonl"), new Date(), new Date(NOW + 10_000));
    const after = await searchArchive({ storage, query: "zephyr unique marker", now: NOW });
    expect(after.hits).toHaveLength(1);
    expect(after.hits[0]?.text).toContain("zephyr");
  });
});

describe("storage chunk-session sidecar", () => {
  it("round-trips chunk session metadata", async () => {
    await storage.ensureLayout();
    await storage.recordChunkSession("c1", "sess-1", 111);
    await storage.recordChunkSession("c2", "sess-2", 222);
    // Upsert semantics on the same chunk.
    await storage.recordChunkSession("c1", "sess-1b", 333);
    const map = await storage.readChunkSessions();
    expect(map.get("c1")).toEqual({ sessionId: "sess-1b", createdAt: 333 });
    expect(map.get("c2")).toEqual({ sessionId: "sess-2", createdAt: 222 });
  });
});
