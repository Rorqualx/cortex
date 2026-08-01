/**
 * Tests for the checkpoint-preservation gate (RSIBench-Data, arXiv:2607.25886).
 *
 * The gate prevents cards from advancing from `probe` → `test` when the probe
 * didn't beat the baseline by the promotion threshold. Instead, the card is
 * walked back to `design`.
 */

import { describe, expect, it } from "vitest";
import {
  compareProbeToBaseline,
  evaluateProbeGate,
  DEFAULT_PROBE_PROMOTION_THRESHOLD,
} from "./probe-gate.js";

describe("compareProbeToBaseline", () => {
  it("returns improved=true when probe beats baseline by ≥ threshold", () => {
    const result = compareProbeToBaseline(0.85, 0.7, 0.05);
    expect(result.improved).toBe(true);
    expect(result.delta).toBe(0.15);
    expect(result.recommendation).toBe("test");
  });

  it("returns improved=true when delta exactly equals threshold", () => {
    const result = compareProbeToBaseline(0.75, 0.7, 0.05);
    expect(result.improved).toBe(true);
    expect(result.delta).toBe(0.05);
    expect(result.recommendation).toBe("test");
  });

  it("returns improved=false when probe barely improves but below threshold", () => {
    const result = compareProbeToBaseline(0.72, 0.7, 0.05);
    expect(result.improved).toBe(false);
    expect(result.delta).toBe(0.02);
    expect(result.recommendation).toBe("design");
  });

  it("returns improved=false when probe regresses", () => {
    const result = compareProbeToBaseline(0.65, 0.7, 0.05);
    expect(result.improved).toBe(false);
    expect(result.delta).toBe(-0.05);
    expect(result.recommendation).toBe("design");
  });

  it("returns improved=false when probe equals baseline", () => {
    const result = compareProbeToBaseline(0.7, 0.7, 0.05);
    expect(result.improved).toBe(false);
    expect(result.delta).toBe(0);
    expect(result.recommendation).toBe("design");
  });

  it("uses default threshold of 0.05 when not specified", () => {
    expect(DEFAULT_PROBE_PROMOTION_THRESHOLD).toBe(0.05);
    const result = compareProbeToBaseline(0.74, 0.7);
    expect(result.improved).toBe(false); // 0.04 < 0.05
  });

  it("rounds delta to 6 decimal places", () => {
    const result = compareProbeToBaseline(0.8000003, 0.7, 0.0000001);
    expect(result.delta).toBeCloseTo(0.1000003, 6);
  });
});

describe("evaluateProbeGate", () => {
  it("returns null when probeBaseline is undefined", () => {
    expect(evaluateProbeGate(undefined, 0.8)).toBeNull();
  });

  it("returns null when probeResult is undefined", () => {
    expect(evaluateProbeGate(0.7, undefined)).toBeNull();
  });

  it("returns null when both are undefined", () => {
    expect(evaluateProbeGate(undefined, undefined)).toBeNull();
  });

  it("returns comparison when both values are present", () => {
    const result = evaluateProbeGate(0.7, 0.85);
    expect(result).not.toBeNull();
    expect(result!.improved).toBe(true);
    expect(result!.recommendation).toBe("test");
  });

  it("passes through custom threshold", () => {
    const result = evaluateProbeGate(0.7, 0.73, 0.05);
    expect(result).not.toBeNull();
    expect(result!.improved).toBe(false);
    expect(result!.delta).toBe(0.03);
  });
});
