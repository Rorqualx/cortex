import { afterEach, describe, expect, it } from "vitest";
import {
  containExecOutputForModel,
  DEFAULT_EXEC_OUTPUT_BUDGET,
  resolveExecOutputBudget,
} from "./bash-tools.exec-output.js";

// Per-tool output containment at the exec boundary (QW3, 2026-10-02): verbose
// completed-exec output is contained before it enters L1 — log-like output via
// the shared log-compressor digest, other output via head/tail excerpt — while
// details.aggregated keeps the full text recoverable.

function repeatedLog(line: string, count: number): string {
  return Array.from({ length: count }, () => line).join("\n");
}

describe("containExecOutputForModel", () => {
  it("passes through output at or under budget untouched", () => {
    expect(containExecOutputForModel("short output", 100)).toBe("short output");
    const exactly = "x".repeat(50);
    expect(containExecOutputForModel(exactly, 50)).toBe(exactly);
  });

  it("digests long log-like output, keeps error lines, and notes full recovery", () => {
    const log = `${repeatedLog("2026-10-02T06:00:00Z info handled request /a", 2000)}\nERROR boom`;
    const contained = containExecOutputForModel(log, 1000);
    expect(contained.startsWith("[exec output contained")).toBe(true);
    expect(contained).toContain("log digest");
    expect(contained).toContain("details");
    expect(contained.length).toBeLessThan(1500);
    expect(contained).toContain("ERROR boom");
    expect(contained).toContain("identical lines omitted");
  });

  it("head/tail excerpts non-log output with an omission marker", () => {
    // Five very long lines: under the log-compressor's 15-line threshold, so it
    // must fall back to a head/tail excerpt rather than a digest.
    const blob = Array.from({ length: 5 }, () => "y".repeat(3000)).join("\n");
    const contained = containExecOutputForModel(blob, 1000);
    expect(contained.startsWith("[exec output contained")).toBe(true);
    expect(contained).toContain("head/tail excerpt");
    expect(contained).toContain("chars omitted");
    expect(contained.length).toBeLessThan(blob.length);
    expect(contained.length).toBeLessThan(1400);
    expect(contained).toContain("yyy");
  });

  it("keeps the head and the tail of excerpted output", () => {
    const head = "HEAD-MARKER ";
    const tail = " TAIL-MARKER";
    const blob = `${head}${"m".repeat(5000)}${tail}`;
    const contained = containExecOutputForModel(blob, 1000);
    expect(contained).toContain("HEAD-MARKER");
    expect(contained).toContain("TAIL-MARKER");
  });

  it("respects an explicit budget", () => {
    const text = "z".repeat(500);
    const contained = containExecOutputForModel(text, 100);
    // budget + fixed note/marker overhead (~120 chars), still far under the original.
    expect(contained.length).toBeLessThan(300);
    expect(contained.length).toBeLessThan(text.length);
    expect(contained).toContain("chars omitted");
  });
});

describe("resolveExecOutputBudget", () => {
  const ENV_KEY = "OPENCLAW_EXEC_OUTPUT_BUDGET_CHARS";
  let prev: string | undefined;

  afterEach(() => {
    // Restore the pre-test environment without assuming it was set.
    if (prev === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = prev;
    }
  });

  it("defaults to the conservative budget when unset or unparseable", () => {
    prev = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    expect(resolveExecOutputBudget()).toBe(DEFAULT_EXEC_OUTPUT_BUDGET);
    process.env[ENV_KEY] = "not-a-number";
    expect(resolveExecOutputBudget()).toBe(DEFAULT_EXEC_OUTPUT_BUDGET);
  });

  it("clamps the env override into [2k, 200k]", () => {
    prev = process.env[ENV_KEY];
    process.env[ENV_KEY] = "999999";
    expect(resolveExecOutputBudget()).toBe(200_000);
    process.env[ENV_KEY] = "1";
    expect(resolveExecOutputBudget()).toBe(2_000);
    process.env[ENV_KEY] = "8000";
    expect(resolveExecOutputBudget()).toBe(8_000);
  });
});
