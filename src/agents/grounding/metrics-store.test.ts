import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeGroundingMetricsStoreForTest,
  localDay,
  recordGroundingCheck,
  recordRetrievalToolCall,
  summarizeGroundingMetrics,
  summarizeReacquisitionMetrics,
} from "./metrics-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "grounding-metrics-"));
});

afterEach(() => {
  closeGroundingMetricsStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

const T = Date.parse("2026-06-16T12:00:00");

describe("grounding metrics store", () => {
  it("aggregates day-bucketed counters across outcomes and agents", () => {
    recordGroundingCheck({ agentId: "main", outcome: "grounded", revised: false, now: T, dir });
    recordGroundingCheck({ agentId: "main", outcome: "ungrounded", revised: true, now: T, dir });
    recordGroundingCheck({ agentId: "varys", outcome: "skipped", revised: false, now: T, dir });
    recordGroundingCheck({ agentId: "varys", outcome: "ungrounded", revised: true, now: T, dir });

    const summary = summarizeGroundingMetrics({ fromDay: localDay(T), dir });
    expect(summary.checked).toBe(4);
    expect(summary.grounded).toBe(1);
    expect(summary.ungrounded).toBe(2);
    expect(summary.revised).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.byAgent).toEqual([
      { agentId: "main", checked: 2, ungrounded: 1, revised: 1 },
      { agentId: "varys", checked: 2, ungrounded: 1, revised: 1 },
    ]);
  });

  it("excludes days before fromDay", () => {
    const yesterday = T - 24 * 60 * 60 * 1000;
    recordGroundingCheck({
      agentId: "main",
      outcome: "grounded",
      revised: false,
      now: yesterday,
      dir,
    });
    recordGroundingCheck({ agentId: "main", outcome: "grounded", revised: false, now: T, dir });

    const summary = summarizeGroundingMetrics({ fromDay: localDay(T), dir });
    expect(summary.checked).toBe(1);
  });

  it("returns zeros when no data matches", () => {
    const summary = summarizeGroundingMetrics({ fromDay: "2099-01-01", dir });
    expect(summary.checked).toBe(0);
    expect(summary.byAgent).toEqual([]);
    expect(summary.avgPreConfidence).toBeUndefined();
    expect(summary.avgPostConfidence).toBeUndefined();
  });

  it("stores and averages confidence values", () => {
    recordGroundingCheck({
      agentId: "main",
      outcome: "grounded",
      revised: false,
      preConfidence: 0.8,
      postConfidence: 0.9,
      now: T,
      dir,
    });
    recordGroundingCheck({
      agentId: "main",
      outcome: "grounded",
      revised: false,
      preConfidence: 0.6,
      postConfidence: 0.7,
      now: T,
      dir,
    });
    recordGroundingCheck({ agentId: "main", outcome: "skipped", revised: false, now: T, dir });

    const summary = summarizeGroundingMetrics({ fromDay: localDay(T), dir });
    expect(summary.checked).toBe(3);
    expect(summary.avgPreConfidence).toBeCloseTo((0.8 + 0.6) / 3, 6);
    expect(summary.avgPostConfidence).toBeCloseTo((0.9 + 0.7) / 3, 6);
  });

  it("localDay formats the local calendar day", () => {
    expect(localDay(T)).toBe("2026-06-16");
  });
});

describe("reacquisition telemetry", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("counts only retrieval-type tools, day-bucketed per agent", () => {
    recordRetrievalToolCall({ agentId: "main", toolName: "memory_search", now: T, dir });
    recordRetrievalToolCall({ agentId: "main", toolName: "read", now: T, dir });
    recordRetrievalToolCall({ agentId: "main", toolName: "memory_get", now: T, dir });
    recordRetrievalToolCall({ agentId: "main", toolName: "exec", now: T, dir });
    recordRetrievalToolCall({ agentId: "main", toolName: "write", now: T, dir });

    const summary = summarizeReacquisitionMetrics({ fromDay: localDay(T), dir });
    expect(summary.totalRetrievalCalls).toBe(3);
    expect(summary.byDay).toEqual([
      { day: "2026-06-16", agentId: "main", retrievalCalls: 3, surge: false },
    ]);
    // First day has no trailing baseline — never a surge.
    expect(summary.surges).toBe(0);
  });

  it("flags a post-compression surge above the trailing mean", () => {
    // Three baseline days at 6 calls/day for main.
    for (let d = 0; d < 3; d++) {
      for (let i = 0; i < 6; i++) {
        recordRetrievalToolCall({
          agentId: "main",
          toolName: "memory_search",
          now: T + d * DAY_MS,
          dir,
        });
      }
    }
    // Day 4: compression shipped — 12 calls (> 1.5 × 6).
    for (let i = 0; i < 12; i++) {
      recordRetrievalToolCall({
        agentId: "main",
        toolName: "read",
        now: T + 3 * DAY_MS,
        dir,
      });
    }
    const summary = summarizeReacquisitionMetrics({ fromDay: localDay(T), dir });
    expect(summary.totalRetrievalCalls).toBe(30);
    const last = summary.byDay.at(-1);
    expect(last?.surge).toBe(true);
    expect(summary.surges).toBe(1);
  });

  it("does not flag small days below the min baseline", () => {
    // Two baseline days at 2 calls/day (below default minBaseline=5).
    for (let d = 0; d < 2; d++) {
      for (let i = 0; i < 2; i++) {
        recordRetrievalToolCall({
          agentId: "varys",
          toolName: "memory_search",
          now: T + d * DAY_MS,
          dir,
        });
      }
    }
    // Day 3: 10 calls — > 1.5 × 2, but baseline mean 2 < minBaseline 5.
    for (let i = 0; i < 10; i++) {
      recordRetrievalToolCall({
        agentId: "varys",
        toolName: "memory_search",
        now: T + 2 * DAY_MS,
        dir,
      });
    }
    const summary = summarizeReacquisitionMetrics({ fromDay: localDay(T), dir });
    expect(summary.surges).toBe(0);
    expect(summary.byDay.every((d) => !d.surge)).toBe(true);
  });

  it("returns empty summary when no data matches", () => {
    const summary = summarizeReacquisitionMetrics({ fromDay: "2099-01-01", dir });
    expect(summary.totalRetrievalCalls).toBe(0);
    expect(summary.byDay).toEqual([]);
    expect(summary.surges).toBe(0);
  });
});
