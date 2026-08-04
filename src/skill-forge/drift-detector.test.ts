import { describe, expect, it } from "vitest";
import type { TrajectoryEvent } from "../trajectory/types.js";
import {
  computeToolResponseSignature,
  detectSchemaDrift,
  DEFAULT_DRIFT_THRESHOLD,
} from "./drift-detector.js";

function toolResultEvent(content: string | unknown, isError = false): TrajectoryEvent {
  const message: Record<string, unknown> = {};
  if (typeof content === "string") {
    message.content = content;
  } else if (Array.isArray(content)) {
    message.content = content;
  } else {
    message.content = JSON.stringify(content);
  }
  if (isError) {
    message.isError = true;
  }
  return {
    type: "tool.result",
    data: { message },
    timestamp: Date.now(),
  } as unknown as TrajectoryEvent;
}

function toolCallEvent(name: string): TrajectoryEvent {
  return {
    type: "tool.call",
    data: { name, arguments: {} },
    timestamp: Date.now(),
  } as unknown as TrajectoryEvent;
}

describe("computeToolResponseSignature", () => {
  it("returns undefined for fewer than 3 tool results", () => {
    expect(
      computeToolResponseSignature([toolResultEvent("ok"), toolResultEvent("ok")]),
    ).toBeUndefined();
  });

  it("computes median length, error rate, and JSON keys", () => {
    const events = [
      toolResultEvent('{"status": "ok", "data": [1, 2]}'),
      toolResultEvent('{"status": "ok", "data": [3]}'),
      toolResultEvent('{"status": "error", "code": 500}', true),
      toolResultEvent("plain text response"),
      toolResultEvent('{"status": "ok", "data": [4, 5, 6]}'),
    ];
    const sig = computeToolResponseSignature(events);
    expect(sig).toBeDefined();
    expect(sig!.sampleSize).toBe(5);
    expect(sig!.errorRate).toBeCloseTo(0.2, 1);
    expect(sig!.jsonKeys).toContain("status");
    expect(sig!.jsonKeys).toContain("data");
    expect(sig!.jsonKeys).toContain("code");
  });

  it("ignores non-tool-result events", () => {
    const events = [
      toolCallEvent("read"),
      toolResultEvent("response 1"),
      toolResultEvent("response 2"),
      toolResultEvent("response 3"),
    ];
    const sig = computeToolResponseSignature(events);
    expect(sig?.sampleSize).toBe(3);
  });

  it("handles array content blocks", () => {
    const events = [
      toolResultEvent([{ type: "text", text: '{"key": "val"}' }]),
      toolResultEvent([{ type: "text", text: '{"key": "val2"}' }]),
      toolResultEvent([{ type: "text", text: '{"key": "val3"}' }]),
    ];
    const sig = computeToolResponseSignature(events);
    expect(sig?.jsonKeys).toEqual(["key"]);
  });
});

describe("detectSchemaDrift", () => {
  const baseline: import("./drift-detector.js").ToolResponseSignature = {
    medianLength: 500,
    iqrLength: 100,
    errorRate: 0.1,
    jsonKeys: ["status", "data", "id"],
    sampleSize: 10,
  };

  it("returns low divergence for similar signatures", () => {
    const current = { ...baseline, medianLength: 520, errorRate: 0.1, sampleSize: 12 };
    const result = detectSchemaDrift(baseline, current);
    expect(result.divergence).toBeLessThan(0.2);
    expect(result.isDrifted).toBe(false);
    expect(result.signals).toHaveLength(0);
  });

  it("detects length drift when median response size doubles", () => {
    const current = { ...baseline, medianLength: 1200, sampleSize: 10 };
    const result = detectSchemaDrift(baseline, current);
    expect(result.divergence).toBeGreaterThan(0.2);
    expect(result.signals.some((s) => s.includes("length"))).toBe(true);
  });

  it("detects error-rate drift when errors spike", () => {
    const current = { ...baseline, errorRate: 0.6, sampleSize: 10 };
    const result = detectSchemaDrift(baseline, current);
    expect(result.divergence).toBeGreaterThan(0.15);
    expect(result.signals.some((s) => s.includes("error rate"))).toBe(true);
  });

  it("detects missing JSON keys", () => {
    const current = {
      ...baseline,
      jsonKeys: ["status"], // missing "data" and "id"
      sampleSize: 10,
    };
    const result = detectSchemaDrift(baseline, current);
    expect(result.signals.some((s) => s.includes("missing JSON keys"))).toBe(true);
  });

  it("flags as drifted when divergence exceeds threshold", () => {
    const current = {
      medianLength: 2000,
      iqrLength: 500,
      errorRate: 0.5,
      jsonKeys: [],
      sampleSize: 10,
    };
    const result = detectSchemaDrift(baseline, current);
    expect(result.isDrifted).toBe(true);
    expect(result.divergence).toBeGreaterThanOrEqual(DEFAULT_DRIFT_THRESHOLD);
  });

  it("respects a custom threshold", () => {
    const current = { ...baseline, medianLength: 600, errorRate: 0.15, sampleSize: 10 };
    const strict = detectSchemaDrift(baseline, current, 0.05);
    const lenient = detectSchemaDrift(baseline, current, 0.5);
    expect(strict.isDrifted).toBe(true);
    expect(lenient.isDrifted).toBe(false);
  });
});
