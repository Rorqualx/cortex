import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countToolCalls, evaluateReacquisition, windowStats } from "./reacquisition.js";
import { Storage } from "./storage.js";

type Message = { role: string; content?: unknown };

const userMsg = (text: string): Message => ({ role: "user", content: text });

const assistantMsg = (toolCalls: number): Message => ({
  role: "assistant",
  content: [
    { type: "text", text: "thinking..." },
    ...Array.from({ length: toolCalls }, (_, i) => ({
      type: "toolCall",
      id: `call-${i}`,
      name: "read",
      arguments: {},
    })),
  ],
});

let tmpRoot: string;
let storage: Storage;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-reacquisition-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("countToolCalls", () => {
  it("counts assistant tool-call blocks only", () => {
    const messages = [
      userMsg("hi"),
      assistantMsg(2),
      { role: "toolResult", toolCallId: "call-0", content: [] },
      assistantMsg(1),
      { role: "custom", customType: "x", content: "y", display: false, timestamp: 0 },
    ];
    expect(countToolCalls(messages as never[])).toBe(3);
  });

  it("returns 0 for prose-only windows", () => {
    expect(
      countToolCalls([
        userMsg("a"),
        { role: "assistant", content: [{ type: "text", text: "b" }] },
      ] as never[]),
    ).toBe(0);
  });
});

describe("windowStats", () => {
  it("computes tool calls per assistant message", () => {
    const stats = windowStats([userMsg("q"), assistantMsg(2), assistantMsg(1)] as never[]);
    expect(stats).toEqual({
      messages: 3,
      assistantMessages: 2,
      toolCalls: 3,
      toolCallRate: 1.5,
    });
  });

  it("rate is 0 with no assistant messages", () => {
    const stats = windowStats([userMsg("q")] as never[]);
    expect(stats.toolCallRate).toBe(0);
    expect(stats.assistantMessages).toBe(0);
  });
});

describe("evaluateReacquisition", () => {
  const stats = (assistant: number, calls: number) => ({
    messages: assistant,
    assistantMessages: assistant,
    toolCalls: calls,
    toolCallRate: assistant > 0 ? calls / assistant : 0,
  });

  it("fires a spike when post-compaction rate jumps past the ratio", () => {
    const outcome = evaluateReacquisition(stats(10, 5), stats(10, 10));
    // 0.5 -> 1.0 is exactly 2x, above the 1.5 default ratio.
    expect(outcome.spike).toBe(true);
    expect(outcome.ratio).toBeCloseTo(2);
  });

  it("does not fire on flat rates", () => {
    const outcome = evaluateReacquisition(stats(10, 8), stats(10, 9));
    expect(outcome.spike).toBe(false);
    expect(outcome.ratio).toBeCloseTo(1.125);
  });

  it("requires the post-window call floor even with a big ratio", () => {
    // 2 calls in 10 assistant messages -> rate 0.2; before 0.1 -> ratio 2x,
    // but only 2 calls — under the default floor of 3.
    const outcome = evaluateReacquisition(stats(10, 1), stats(10, 2));
    expect(outcome.spike).toBe(false);
  });

  it("treats a zero pre-rate with qualifying post activity as a spike", () => {
    const outcome = evaluateReacquisition(stats(10, 0), stats(10, 5));
    expect(outcome.spike).toBe(true);
    expect(outcome.ratio).toBeNull();
  });
});

describe("storage roundtrip", () => {
  it("records and reads reacquisition events", async () => {
    await storage.ensureLayout();
    await storage.recordReacquisitionEvent(
      {
        sessionId: "s1",
        compactionAt: 1000,
        cursorMessages: 42,
        beforeRate: 0.5,
        afterRate: 1.25,
        ratio: 2.5,
        spike: true,
        beforeToolCalls: 5,
        afterToolCalls: 12,
      },
      2000,
    );
    await storage.recordReacquisitionEvent(
      {
        sessionId: "s2",
        compactionAt: 3000,
        cursorMessages: 7,
        beforeRate: 1,
        afterRate: 1,
        ratio: 1,
        spike: false,
        beforeToolCalls: 4,
        afterToolCalls: 4,
      },
      4000,
    );
    const all = await storage.readReacquisitionEvents();
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual({
      sessionId: "s1",
      compactionAt: 1000,
      cursorMessages: 42,
      beforeRate: 0.5,
      afterRate: 1.25,
      ratio: 2.5,
      spike: true,
      beforeToolCalls: 5,
      afterToolCalls: 12,
      createdAt: 2000,
    });
    const since = await storage.readReacquisitionEvents(2500);
    expect(since).toHaveLength(1);
    expect(since[0]?.sessionId).toBe("s2");
  });
});
