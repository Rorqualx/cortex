// Per-session chat runtime capture/apply behavior.
import { describe, expect, it } from "vitest";
import {
  applyChatRuntime,
  captureChatRuntime,
  shouldRetainChatRuntime,
  type ChatRuntimeHost,
  type SessionChatRuntime,
} from "./session-runtime.ts";

function makeHost(): ChatRuntimeHost {
  return {
    chatMessages: [{ role: "assistant", content: "hi" }],
    chatToolMessages: [{ role: "toolResult", content: "ok" }],
    chatStreamSegments: [{ text: "seg", ts: 1 }],
    chatStream: "streaming...",
    chatStreamStartedAt: 111,
    chatThinkingStream: "thinking...",
    chatThinkingStreamStartedAt: 222,
    chatThinkingLevel: "high",
    chatRunId: "run-1",
    chatSending: true,
    chatSendStartedAt: 333,
    chatRunStatus: { phase: "done", runId: "run-1", sessionKey: "s", occurredAt: 5 },
    lastLocalTerminalReconcile: null,
    chatLoading: false,
    chatHistoryHasMore: true,
    chatHistoryNextCursor: "cursor-1",
    currentSessionId: "sess-1",
    chatSideResult: null,
    chatSideResultTerminalRuns: new Set(["r1"]),
    chatLiveUsage: null,
    branchPoints: [],
    branchActivePath: ["a", "b"],
    toolStreamById: new Map([["t1", {} as never]]),
    toolStreamOrder: ["t1"],
  };
}

function blankHost(): ChatRuntimeHost {
  return {
    chatMessages: [],
    chatToolMessages: [],
    chatStreamSegments: [],
    chatStream: null,
    chatStreamStartedAt: null,
    chatThinkingStream: null,
    chatThinkingStreamStartedAt: null,
    chatThinkingLevel: null,
    chatRunId: null,
    chatSending: false,
    chatSendStartedAt: null,
    chatRunStatus: null,
    lastLocalTerminalReconcile: null,
    chatLoading: false,
    chatHistoryHasMore: false,
    chatHistoryNextCursor: null,
    currentSessionId: null,
    chatSideResult: null,
    chatSideResultTerminalRuns: new Set(),
    chatLiveUsage: null,
    branchPoints: undefined,
    branchActivePath: undefined,
    toolStreamById: new Map(),
    toolStreamOrder: [],
  };
}

describe("session-runtime", () => {
  it("round-trips every field through capture → apply", () => {
    const source = makeHost();
    const snapshot = captureChatRuntime(source);
    const target = blankHost();
    applyChatRuntime(target, snapshot);
    // Re-capturing the target must equal the original snapshot: proves apply
    // writes every field capture reads (completeness in both directions).
    expect(captureChatRuntime(target)).toEqual(snapshot);
    expect(target.chatRunId).toBe("run-1");
    expect(target.chatMessages).toBe(snapshot.chatMessages);
  });

  it("decouples the Map/Set snapshot from later in-place clears of the source", () => {
    const source = makeHost();
    const snapshot = captureChatRuntime(source);
    // resetToolStream / reconcileChatRunLifecycle clear these in place.
    source.toolStreamById.clear();
    source.chatSideResultTerminalRuns.clear();
    expect(snapshot.toolStreamById.size).toBe(1);
    expect(snapshot.chatSideResultTerminalRuns.has("r1")).toBe(true);
  });

  it("retains a runtime only while it has a live run", () => {
    expect(shouldRetainChatRuntime(captureChatRuntime(makeHost()))).toBe(true);
    const idle: SessionChatRuntime = {
      ...captureChatRuntime(makeHost()),
      chatRunId: null,
      chatSending: false,
      chatStream: null,
    };
    expect(shouldRetainChatRuntime(idle)).toBe(false);
  });
});
