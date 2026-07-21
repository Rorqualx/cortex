import { describe, expect, it } from "vitest";
import { selectSlidingWindow } from "./sliding-window.js";
import { estimateMessageTokens } from "./token-estimate.js";

const userMsg = (content: string) => ({ role: "user", content }) as never;
const assistantTextMsg = (text: string) =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
  }) as never;
const assistantToolCallMsg = (toolCallId: string) =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", toolCallId, name: "tool", arguments: {} }],
  }) as never;
const toolResultMsg = (toolCallId: string, output: string) =>
  ({
    role: "toolResult",
    toolCallId,
    toolName: "tool",
    content: [{ type: "text", text: output }],
    isError: false,
  }) as never;

describe("selectSlidingWindow", () => {
  it("returns empty when given no messages", () => {
    expect(selectSlidingWindow({ messages: [], tokenBudget: 1000 })).toEqual({
      selected: [],
      estimatedTokens: 0,
    });
  });

  it("returns empty when token budget is non-positive", () => {
    expect(selectSlidingWindow({ messages: [userMsg("hi")], tokenBudget: 0 })).toEqual({
      selected: [],
      estimatedTokens: 0,
    });
  });

  it("returns all messages when total fits within budget", () => {
    const messages = [userMsg("alpha"), assistantTextMsg("beta"), userMsg("gamma")];
    const result = selectSlidingWindow({ messages, tokenBudget: 100 });
    expect(result.selected).toHaveLength(3);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("always includes the last message even when it alone exceeds the budget", () => {
    const huge = userMsg("x".repeat(4000));
    const result = selectSlidingWindow({
      messages: [userMsg("a"), huge],
      tokenBudget: 5,
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toBe(huge);
  });

  it("trims oldest messages until the tail fits the budget", () => {
    const messages = [userMsg("first"), userMsg("second"), userMsg("third"), userMsg("fourth")];
    const lastTwoCost = estimateMessageTokens(messages[2]!) + estimateMessageTokens(messages[3]!);
    const result = selectSlidingWindow({ messages, tokenBudget: lastTwoCost });
    expect(result.selected).toHaveLength(2);
    expect(result.selected[0]).toBe(messages[2]);
    expect(result.selected[1]).toBe(messages[3]);
  });

  it("walks back to include the assistant tool-call when window head is a tool result", () => {
    const messages = [
      userMsg("setup-prompt"),
      assistantToolCallMsg("tc-1"),
      toolResultMsg("tc-1", "result"),
      userMsg("followup"),
    ];
    const lastTwoCost = estimateMessageTokens(messages[2]!) + estimateMessageTokens(messages[3]!);
    const result = selectSlidingWindow({ messages, tokenBudget: lastTwoCost });
    expect(result.selected[0]).toBe(messages[1]);
    expect((result.selected[0] as { role: string }).role).toBe("assistant");
  });

  it("walks back over multiple consecutive tool-results", () => {
    const messages = [
      userMsg("setup"),
      assistantToolCallMsg("tc-1"),
      toolResultMsg("tc-1", "r1"),
      toolResultMsg("tc-1", "r2"),
      userMsg("after"),
    ];
    // Budget chosen to start at tc-1's result; walk-back should include the assistant call.
    const result = selectSlidingWindow({
      messages,
      tokenBudget:
        estimateMessageTokens(messages[2]!) +
        estimateMessageTokens(messages[3]!) +
        estimateMessageTokens(messages[4]!),
    });
    expect((result.selected[0] as { role: string }).role).toBe("assistant");
  });
});
