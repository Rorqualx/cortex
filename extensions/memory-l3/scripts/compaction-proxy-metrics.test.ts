import { describe, expect, it } from "vitest";
import {
  computeCompactionProxyMetrics,
  isToolErrorToolResult,
  sumCompactionProxyMetrics,
} from "./compaction-proxy-metrics.mjs";

// REMORY compaction proxy metrics (QW2, 2026-10-09): deterministic repeated-
// tool-output + tool-error counting over replayed session logs. Pure helpers,
// no LLM calls — they ride alongside recall scores as secondary signals.

describe("isToolErrorToolResult", () => {
  it("honors explicit error flags", () => {
    expect(isToolErrorToolResult("ok output", { isError: true })).toBe(true);
    expect(isToolErrorToolResult("ok output", { is_error: true })).toBe(true);
    expect(isToolErrorToolResult("Error: boom", {})).toBe(true);
  });

  it("matches conservative content signatures", () => {
    expect(isToolErrorToolResult("zsh: command not found: foo", {})).toBe(true);
    expect(isToolErrorToolResult("process finished with exit code 1", {})).toBe(true);
    expect(isToolErrorToolResult("ENOENT: no such file or directory", {})).toBe(true);
    expect(isToolErrorToolResult("Traceback (most recent call last):\n  ...", {})).toBe(true);
  });

  it("does not flag successful outputs that merely mention errors", () => {
    expect(isToolErrorToolResult("grep -ri error src/ found 3 matches", {})).toBe(false);
    expect(isToolErrorToolResult("all tests passed, 0 errors", {})).toBe(false);
    expect(isToolErrorToolResult("", {})).toBe(false);
  });
});

describe("computeCompactionProxyMetrics", () => {
  it("returns zeroed rates when there is no tool traffic", () => {
    const m = computeCompactionProxyMetrics([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(m).toEqual({
      toolMessages: 0,
      distinctToolOutputs: 0,
      repeatedToolOutputs: 0,
      repeatedToolOutputRate: 0,
      toolErrors: 0,
      toolErrorRate: 0,
    });
  });

  it("counts OpenAI-style role:tool messages and repeats after whitespace normalization", () => {
    const m = computeCompactionProxyMetrics([
      { role: "tool", content: "README.md\npackage.json" },
      { role: "assistant", content: "not a tool" },
      { role: "tool", content: "README.md package.json" }, // same payload, formatting differs
      { role: "tool", content: "something else" },
    ]);
    expect(m.toolMessages).toBe(3);
    expect(m.distinctToolOutputs).toBe(2);
    expect(m.repeatedToolOutputs).toBe(1);
    expect(m.repeatedToolOutputRate).toBeCloseTo(1 / 3, 5);
  });

  it("counts Anthropic-style tool_result blocks including nested string content", () => {
    const m = computeCompactionProxyMetrics([
      {
        role: "user",
        content: [
          { type: "tool_result", content: "nested payload" },
          { type: "text", text: "not a tool result" },
        ],
      },
      { role: "user", content: [{ type: "tool_result", content: [{ text: "block payload" }] }] },
    ]);
    expect(m.toolMessages).toBe(2);
    expect(m.distinctToolOutputs).toBe(2);
    expect(m.repeatedToolOutputs).toBe(0);
  });

  it("detects repeated tool errors (REMORY repeated-failure signal)", () => {
    const m = computeCompactionProxyMetrics([
      { role: "tool", content: "zsh: command not found: jq" },
      { role: "tool", content: "zsh: command not found: jq" },
      { role: "tool", content: "ok" },
    ]);
    expect(m.toolMessages).toBe(3);
    expect(m.toolErrors).toBe(2);
    expect(m.toolErrorRate).toBeCloseTo(2 / 3, 5);
    // The repeated error is also a repeated payload.
    expect(m.repeatedToolOutputs).toBe(1);
  });

  it("honors isError flags on role:tool and tool_result shapes", () => {
    const m = computeCompactionProxyMetrics([
      { role: "tool", content: "anything", isError: true },
      { role: "user", content: [{ type: "tool_result", content: "x", is_error: true }] },
    ]);
    expect(m.toolMessages).toBe(2);
    expect(m.toolErrors).toBe(2);
  });

  it("ignores null/undefined/malformed messages", () => {
    const m = computeCompactionProxyMetrics([null, undefined, {}, "junk"]);
    expect(m.toolMessages).toBe(0);
  });
});

describe("sumCompactionProxyMetrics", () => {
  it("sums counts and recomputes rates over the pool", () => {
    const a = computeCompactionProxyMetrics([
      { role: "tool", content: "x" },
      { role: "tool", content: "x" },
    ]);
    const b = computeCompactionProxyMetrics([{ role: "tool", content: "Error: nope" }]);
    const totals = sumCompactionProxyMetrics([a, b]);
    expect(totals.toolMessages).toBe(3);
    expect(totals.repeatedToolOutputs).toBe(1);
    expect(totals.toolErrors).toBe(1);
    expect(totals.repeatedToolOutputRate).toBeCloseTo(1 / 3, 5);
    expect(totals.toolErrorRate).toBeCloseTo(1 / 3, 5);
  });

  it("returns zeros for an empty pool", () => {
    const totals = sumCompactionProxyMetrics([]);
    expect(totals.toolMessages).toBe(0);
    expect(totals.repeatedToolOutputRate).toBe(0);
  });
});
