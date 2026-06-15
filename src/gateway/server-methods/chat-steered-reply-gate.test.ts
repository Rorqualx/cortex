import { describe, expect, it } from "vitest";
import { createSteeredFollowupReplyGate } from "./chat-steered-reply-gate.js";

describe("createSteeredFollowupReplyGate", () => {
  it("treats the first terminal reply as the dispatch's primary reply", () => {
    const classify = createSteeredFollowupReplyGate();
    expect(classify("stop")).toEqual({ kind: "primary" });
  });

  it("treats each later terminal reply as a steered follow-up with an increasing index", () => {
    const classify = createSteeredFollowupReplyGate();
    expect(classify("stop")).toEqual({ kind: "primary" });
    expect(classify("stop")).toEqual({ kind: "steered", followupIndex: 1 });
    expect(classify("stop")).toEqual({ kind: "steered", followupIndex: 2 });
  });

  it("ignores intermediate tool-call turns and does not count them", () => {
    const classify = createSteeredFollowupReplyGate();
    // A tool-using primary reply: assistant(tool_use) -> tool -> assistant(stop).
    expect(classify("tool_use")).toEqual({ kind: "ignore" });
    expect(classify("stop")).toEqual({ kind: "primary" });
    // A tool-using steered reply must still be the first *steered* (index 1).
    expect(classify("tool_use")).toEqual({ kind: "ignore" });
    expect(classify("stop")).toEqual({ kind: "steered", followupIndex: 1 });
  });

  it("treats any non-tool_use stop reason as a terminal reply", () => {
    const classify = createSteeredFollowupReplyGate();
    expect(classify("end_turn")).toEqual({ kind: "primary" });
    expect(classify("max_tokens")).toEqual({ kind: "steered", followupIndex: 1 });
    expect(classify(undefined)).toEqual({ kind: "steered", followupIndex: 2 });
  });

  it("keeps independent state per run", () => {
    const runA = createSteeredFollowupReplyGate();
    const runB = createSteeredFollowupReplyGate();
    expect(runA("stop")).toEqual({ kind: "primary" });
    expect(runA("stop")).toEqual({ kind: "steered", followupIndex: 1 });
    // A fresh run starts over: its first terminal reply is primary, not steered.
    expect(runB("stop")).toEqual({ kind: "primary" });
  });
});
