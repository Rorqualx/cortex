import { describe, expect, it } from "vitest";
import { estimateMessageTokens, estimateTotalTokens } from "./token-estimate.js";

describe("estimateMessageTokens", () => {
  it("counts string content with ~4 chars per token plus 1 overhead", () => {
    const msg = { role: "user", content: "hello world" } as never;
    // "hello world" = 11 chars → ceil(11/4) = 3, plus +1 overhead = 4
    expect(estimateMessageTokens(msg)).toBe(4);
  });

  it("sums per-block costs for content arrays", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "abcd" }, // 4/4 + 1 = 2
        { type: "text", text: "efgh" }, // 4/4 + 1 = 2
      ],
    } as never;
    // 2 + 2 = 4 inner blocks plus +1 overhead = 5
    expect(estimateMessageTokens(msg)).toBe(5);
  });

  it("counts thinking blocks (thinking + signature)", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "abcd", signature: "sig8" }, // 1 + 1 + 1 = 3
      ],
    } as never;
    // 3 inner + 1 overhead = 4
    expect(estimateMessageTokens(msg)).toBe(4);
  });

  it("counts toolCall blocks based on name + serialized arguments", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "toolCall", name: "search", arguments: { q: "hi" } }, // (6 + 11)/4 + 1 = 5
      ],
    } as never;
    expect(estimateMessageTokens(msg)).toBeGreaterThan(0);
  });

  it("falls back to per-block overhead for unknown content types", () => {
    const msg = { role: "user", content: [{ type: "unknown" }] } as never;
    // 1 inner + 1 overhead = 2
    expect(estimateMessageTokens(msg)).toBe(2);
  });

  it("returns the per-block overhead when content shape is unknown", () => {
    const msg = { role: "custom" } as never;
    expect(estimateMessageTokens(msg)).toBe(1);
  });
});

describe("estimateTotalTokens", () => {
  it("sums across messages", () => {
    const messages = [
      { role: "user", content: "abcd" } as never, // 1 + 1 = 2
      { role: "user", content: "efgh" } as never, // 1 + 1 = 2
    ];
    expect(estimateTotalTokens(messages)).toBe(4);
  });

  it("returns 0 for empty input", () => {
    expect(estimateTotalTokens([])).toBe(0);
  });
});
