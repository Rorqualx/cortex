import { describe, expect, it } from "vitest";
import { parseClaudeCodeTranscript } from "./claude-code-transcript.js";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const T1 = "2026-06-01T10:00:00.000Z";
const T2 = "2026-06-01T10:01:00.000Z";
const T3 = "2026-06-01T10:02:00.000Z";

function userLine(content: unknown, extra?: Record<string, unknown>): string {
  return line({
    type: "user",
    timestamp: T1,
    message: { role: "user", content },
    ...extra,
  });
}

function assistantLine(
  blocks: unknown[],
  extra?: { id?: string; timestamp?: string; flags?: Record<string, unknown> },
): string {
  return line({
    type: "assistant",
    timestamp: extra?.timestamp ?? T2,
    message: { id: extra?.id ?? "msg_1", role: "assistant", model: "sonnet-4.6", content: blocks },
    ...extra?.flags,
  });
}

function parse(lines: string[]) {
  return parseClaudeCodeTranscript({ jsonl: lines.join("\n"), sessionId: "s1" });
}

describe("parseClaudeCodeTranscript", () => {
  it("converts user prompts and assistant text with ms timestamps", () => {
    const session = parse([
      userLine("fix the login bug"),
      assistantLine([{ type: "text", text: "Found it in auth.ts." }]),
    ]);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toMatchObject({
      role: "user",
      content: "fix the login bug",
      timestamp: Date.parse(T1),
    });
    expect(session.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Found it in auth.ts." }],
      model: "sonnet-4.6",
      timestamp: Date.parse(T2),
    });
    expect(session.firstTimestamp).toBe(Date.parse(T1));
    expect(session.lastTimestamp).toBe(Date.parse(T2));
  });

  it("merges consecutive assistant entries sharing message.id into one turn", () => {
    const session = parse([
      assistantLine([{ type: "text", text: "Part one." }], { id: "msg_a" }),
      assistantLine([{ type: "text", text: "Part two." }], { id: "msg_a", timestamp: T3 }),
      assistantLine([{ type: "text", text: "New turn." }], { id: "msg_b", timestamp: T3 }),
    ]);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toMatchObject({
      content: [{ type: "text", text: "Part one.\nPart two." }],
    });
    expect(session.messages[1]).toMatchObject({ content: [{ type: "text", text: "New turn." }] });
  });

  it("does not merge same-id assistant entries split by a user message", () => {
    const session = parse([
      assistantLine([{ type: "text", text: "Before." }], { id: "msg_a" }),
      userLine("interjection"),
      assistantLine([{ type: "text", text: "After." }], { id: "msg_a", timestamp: T3 }),
    ]);
    expect(session.messages).toHaveLength(3);
  });

  it("drops harness noise: meta, sidechain, tool blocks, command wrappers, api errors", () => {
    const session = parse([
      userLine("real question"),
      userLine("expanded slash command body", { isMeta: true }),
      userLine("subagent prompt", { isSidechain: true }),
      userLine([{ type: "tool_result", content: "file contents" }]),
      userLine("<command-name>/clear</command-name>"),
      userLine("<local-command-stdout></local-command-stdout>"),
      userLine("[Request interrupted by user]"),
      userLine("<task-notification>\n<task-id>abc</task-id>\n</task-notification>"),
      userLine("<event>[2026-05-16T16:56:27.903Z] [INFO] log line</event>"),
      assistantLine([{ type: "tool_use", name: "Bash", input: {} }]),
      assistantLine([{ type: "thinking", thinking: "internal monologue" }]),
      assistantLine([{ type: "text", text: "Errored." }], { flags: { isApiErrorMessage: true } }),
      line({ type: "file-history-snapshot", snapshot: {} }),
      line({ type: "mode", mode: "normal" }),
      "not json at all {",
    ]);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({ role: "user", content: "real question" });
  });

  it("strips system-reminder blocks from array user content but keeps real text", () => {
    const session = parse([
      userLine([
        { type: "text", text: "<system-reminder>injected context</system-reminder>" },
        { type: "text", text: "please review this" },
      ]),
    ]);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toMatchObject({ content: "please review this" });
  });

  it("returns empty session with zero timestamps for noise-only transcripts", () => {
    const session = parse([line({ type: "summary", summary: "old session" }), ""]);
    expect(session.messages).toEqual([]);
    expect(session.firstTimestamp).toBe(0);
    expect(session.lastTimestamp).toBe(0);
  });
});
