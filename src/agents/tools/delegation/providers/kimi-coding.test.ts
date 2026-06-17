// Tests the OpenAI→Anthropic message translation used by the kimi-for-coding
// client. Pure function — no network.
import { describe, expect, it } from "vitest";
import { toAnthropic } from "./kimi-coding.js";
import type { ChatMessage } from "./types.js";

describe("toAnthropic", () => {
  it("hoists system messages into the system string", () => {
    const { system, messages } = toAnthropic([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]);
    expect(system).toBe("you are helpful");
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("converts assistant tool_calls into tool_use blocks", () => {
    const { messages } = toAnthropic([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "let me check",
        tool_calls: [{ id: "c1", function: { name: "list_dir", arguments: '{"path":"/tmp"}' } }],
      },
    ]);
    const assistant = messages[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "c1", name: "list_dir", input: { path: "/tmp" } },
    ]);
  });

  it("folds role:tool results into a following user tool_result block", () => {
    const { messages } = toAnthropic([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", function: { name: "grep", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "match found" },
    ]);
    // [user, assistant(tool_use), user(tool_result)]
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: "match found" }],
    });
  });

  it("groups multiple consecutive tool results into one user turn", () => {
    const { messages } = toAnthropic([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", function: { name: "t", arguments: "{}" } },
          { id: "b", function: { name: "t", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "ra" },
      { role: "tool", tool_call_id: "b", content: "rb" },
    ]);
    expect(messages).toHaveLength(3);
    const toolResults = messages[2]!.content;
    expect(Array.isArray(toolResults) && toolResults).toHaveLength(2);
  });

  it("tolerates malformed tool-call arguments (empty object input)", () => {
    const { messages } = toAnthropic([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", function: { name: "t", arguments: "not json" } }],
      },
    ]);
    const block = (messages[1]!.content as Array<{ type: string; input?: unknown }>)[0]!;
    expect(block.input).toEqual({});
  });
});
