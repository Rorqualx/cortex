import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeGroundingMetricsStoreForTest,
  localDay,
  recordGroundingCheck,
  summarizeGroundingMetrics,
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
  });

  it("localDay formats the local calendar day", () => {
    expect(localDay(T)).toBe("2026-06-16");
  });
});
