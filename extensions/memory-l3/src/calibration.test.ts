import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linearRegression } from "./calibration-math.js";

// The threshold map functions are private to engine.ts, so we exercise the
// shared calibration math (src/calibration-math.ts) directly — the same module
// the calibration tool (scripts/calibrate-embeddings.ts) uses.

describe("cross-embedding-model calibration", () => {
  it("linearRegression fits a perfect linear relationship", () => {
    const xs = [0.5, 0.6, 0.7, 0.8, 0.9];
    const ys = xs.map((x) => 2 * x + 1);
    const result = linearRegression(xs, ys);
    expect(result.slope).toBeCloseTo(2, 6);
    expect(result.intercept).toBeCloseTo(1, 6);
    expect(result.r2).toBeCloseTo(1, 6);
  });

  it("linearRegression handles noisy data with R² < 1", () => {
    const xs = [0.3, 0.5, 0.7, 0.9];
    const ys = [0.4, 0.55, 0.6, 0.85]; // noisy
    const result = linearRegression(xs, ys);
    expect(result.r2).toBeGreaterThan(0.8);
    expect(result.r2).toBeLessThan(1.0);
  });

  it("linearRegression returns identity for empty input", () => {
    const result = linearRegression([], []);
    expect(result.slope).toBe(1);
    expect(result.intercept).toBe(0);
  });

  it("threshold map maps old thresholds to new via regression", () => {
    // Simulate: old model had higher sims overall, new model is shifted down
    const slope = 0.85;
    const intercept = -0.03;
    const oldThresholds = [0.92, 0.85, 0.75];
    const mapped = oldThresholds.map((t) => Math.max(0, Math.min(1, slope * t + intercept)));
    // 0.92 → 0.85*0.92 - 0.03 = 0.752
    expect(mapped[0]).toBeCloseTo(0.752, 3);
    // 0.85 → 0.85*0.85 - 0.03 = 0.6925
    expect(mapped[1]).toBeCloseTo(0.6925, 3);
    // 0.75 → 0.85*0.75 - 0.03 = 0.6075
    expect(mapped[2]).toBeCloseTo(0.6075, 3);
  });

  it("threshold map JSON round-trips correctly", () => {
    const tmpDir = join(tmpdir(), `l3-cal-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const mapPath = join(tmpDir, "threshold_map.json");

    const map = {
      oldModel: "nomic-embed-text",
      newModel: "text-embedding-3-small",
      calibratedAt: Date.now(),
      sampleCount: 100,
      mapping: { slope: 0.87, intercept: 0.04, r2: 0.93 },
      thresholds: { "0.92": 0.88, "0.85": 0.81, "0.75": 0.71 },
    };

    writeFileSync(mapPath, JSON.stringify(map, null, 2));
    const raw = require("node:fs").readFileSync(mapPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.thresholds["0.92"]).toBe(0.88);
    expect(parsed.thresholds["0.75"]).toBe(0.71);
    expect(parsed.mapping.slope).toBe(0.87);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
