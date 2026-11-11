import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Storage } from "../src/storage.js";
import {
  aggregate,
  loadOutcomesJsonl,
  main,
  pruneEventsDb,
  readEventsDb,
  readOutcomesDb,
  verdictLine,
  type TelemetryEvent,
} from "./retrieval-correlation-report.mjs";

// ARCH-2 v1 (2026-11-11, card 9b9efeea): pure aggregation + join-lane tests
// per the 2026-11-09 test manifest T-R1..T-R6. DB-seeded cases use the real
// Storage class against an explicit temp root (sandbox-HOME gotcha).

const mkEvent = (over: Partial<TelemetryEvent>): TelemetryEvent => ({
  ts: Date.now(),
  sessionId: "sess-1",
  sessionKey: "key-1",
  intentClass: "factual",
  preset: "blended",
  topK: 5,
  factIds: ["chunk-1"],
  estTokens: 120,
  source: "engine-fresh",
  ...over,
});

describe("retrieval correlation report (ARCH-2 v1, 2026-11-11)", () => {
  it("aggregates into exact intentClass × preset buckets (T-R1)", () => {
    const events = [
      mkEvent({ sessionKey: "k1" }),
      mkEvent({ sessionKey: "k2", preset: "routed" }),
      mkEvent({ sessionKey: "k3", intentClass: "synthesis" }),
    ];
    const outcomes = [
      { sessionKey: "k1", ts: 1, ok: true },
      { sessionKey: "k3", ts: 2, ok: false },
    ];
    const agg = aggregate(events, outcomes);
    expect(agg.buckets).toHaveLength(3);
    const factualBlended = agg.buckets.find(
      (b) => b.intentClass === "factual" && b.preset === "blended",
    )!;
    expect(factualBlended.n).toBe(1);
    expect(factualBlended.joined).toBe(1);
    expect(factualBlended.okCount).toBe(1);
    const factualRouted = agg.buckets.find(
      (b) => b.intentClass === "factual" && b.preset === "routed",
    )!;
    expect(factualRouted.joined).toBe(0);
    expect(factualRouted.successRate).toBeNull();
    const synthesis = agg.buckets.find((b) => b.intentClass === "synthesis")!;
    expect(synthesis.okCount).toBe(0);
    expect(synthesis.successRate).toBe(0);
  });

  it("success-rate math + unjoined-rate honesty line (T-R2)", () => {
    const agg = aggregate(
      [mkEvent({ sessionKey: "k1" }), mkEvent({ sessionKey: "k2" })],
      [{ sessionKey: "k1", ts: 1, ok: true }],
    );
    expect(agg.buckets[0]!.n).toBe(2);
    expect(agg.buckets[0]!.joined).toBe(1);
    expect(agg.buckets[0]!.okCount).toBe(1);
    expect(agg.buckets[0]!.successRate).toBe(1);
    expect(agg.unjoinedRate).toBe(0.5);
  });

  it("jsonl outcomes lane equals DB outcomes lane (T-R3)", () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-report-"));
    try {
      const storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
      const ts = Date.now();
      storage.recordRetrievalEvent(mkEvent({ ts, sessionKey: "k1" }));
      storage.recordRetrievalEvent(mkEvent({ ts, sessionKey: "k2", intentClass: "synthesis" }));
      storage.recordRetrievalOutcome({ sessionKey: "k1", ts, ok: true });
      storage.recordRetrievalOutcome({ sessionKey: "k2", ts, ok: false });
      storage.close();

      const dbPath = path.join(tmpRoot, ".openclaw", "l3", "l3.sqlite");
      const dbEvents = readEventsDb(dbPath);
      const dbAgg = aggregate(dbEvents, readOutcomesDb(dbPath));

      const jsonl = [
        JSON.stringify({ sessionKey: "k1", ts, ok: true }),
        JSON.stringify({ sessionKey: "k2", ts, ok: false }),
      ].join("\n");
      const fileAgg = aggregate(dbEvents, loadOutcomesJsonl(jsonl));

      expect(fileAgg).toEqual(dbAgg);
      expect(dbAgg.buckets).toHaveLength(2);
      expect(dbAgg.unjoinedRate).toBe(0);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("verdict line honors min-n (no tiny-n lies) (T-R4)", () => {
    const buckets = [
      {
        intentClass: "factual",
        preset: "routed",
        n: 3,
        joined: 3,
        okCount: 3,
        successRate: 1,
        meanTokens: 100,
      },
      {
        intentClass: "factual",
        preset: "blended",
        n: 10,
        joined: 10,
        okCount: 5,
        successRate: 0.5,
        meanTokens: 100,
      },
    ];
    const verdict = verdictLine(buckets, 5);
    expect(verdict).toContain("blended");
    expect(verdict).not.toContain("routed");
    expect(verdictLine(buckets, 50)).toContain("not enough evidence");
  });

  it("prune helper removes >N-day events and returns the count (T-R5)", () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-report-prune-"));
    try {
      const storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      storage.recordRetrievalEvent(mkEvent({ ts: now - 100 * day }));
      storage.recordRetrievalEvent(mkEvent({ ts: now - 1 * day }));
      storage.close();
      const dbPath = path.join(tmpRoot, ".openclaw", "l3", "l3.sqlite");
      const deleted = pruneEventsDb(dbPath, now - 90 * day);
      expect(deleted).toBe(1);
      expect(readEventsDb(dbPath)).toHaveLength(1);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("CLI smoke: exit 0 and --out writes markdown (T-R6)", () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-report-cli-"));
    try {
      const storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
      storage.recordRetrievalEvent(mkEvent({ sessionKey: "k1" }));
      storage.recordRetrievalOutcome({ sessionKey: "k1", ts: Date.now(), ok: true });
      storage.close();
      const dbPath = path.join(tmpRoot, ".openclaw", "l3", "l3.sqlite");
      const outPath = path.join(tmpRoot, "report.md");
      const code = main([`--db=${dbPath}`, `--out=${outPath}`, "--min-n=1"]);
      expect(code).toBe(0);
      const written = readFileSync(outPath, "utf8");
      expect(written).toContain("| intent | preset |");
      expect(written).toContain("verdict:");
      expect(written).toContain("unjoined rate:");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
