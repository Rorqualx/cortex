// Per-session chat runtime: a snapshot of the run/transcript state that the
// Control UI otherwise keeps only for the single foreground session. Saving it
// on switch-away and restoring it on switch-back lets a session keep its live
// run (and its transcript) while another session is in the foreground, instead
// of the state being wiped on every tab switch.
//
// The captured fields mirror exactly what resetChatStateForSessionSwitch +
// reconcileChatRunLifecycle + resetToolStream reset, plus branchPoints/
// branchActivePath (which the old reset never cleared, leaking across sessions).
import type { ChatLiveUsage, ToolStreamEntry } from "../app-tool-stream.ts";
import type { SessionBranchPoint } from "../types/chat-types.ts";
import type { ChatRunUiStatus, LocalTerminalReconcile } from "./run-lifecycle.ts";
import type { ChatSideResult } from "./side-result.ts";

/**
 * The run/transcript state owned by one session. Every field is required so a
 * newly added per-session field is a compile error here until capture/apply
 * handle it — that prevents state leaking between sessions.
 */
export type SessionChatRuntime = {
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStreamSegments: Array<{ text: string; ts: number; toolCallId?: string }>;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatThinkingStream: string | null;
  chatThinkingStreamStartedAt: number | null;
  chatThinkingLevel: string | null;
  chatRunId: string | null;
  chatSending: boolean;
  chatSendStartedAt: number | null;
  chatRunStatus: ChatRunUiStatus | null;
  lastLocalTerminalReconcile: LocalTerminalReconcile | null;
  chatLoading: boolean;
  chatHistoryHasMore: boolean;
  chatHistoryNextCursor: string | null;
  currentSessionId: string | null;
  chatSideResult: ChatSideResult | null;
  chatSideResultTerminalRuns: Set<string>;
  chatLiveUsage: ChatLiveUsage | null;
  branchPoints: SessionBranchPoint[] | undefined;
  branchActivePath: string[] | undefined;
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
};

/** Structural view of the app state carrying the per-session runtime fields. */
export type ChatRuntimeHost = SessionChatRuntime;

/** Snapshot the foreground session's runtime. Array/plain fields are reassigned
 *  (never mutated in place) by the reset path, so they are captured by reference.
 *  toolStreamById (a Map) and chatSideResultTerminalRuns (a Set) ARE cleared in
 *  place by resetToolStream / reconcileChatRunLifecycle, so they are cloned to
 *  decouple the snapshot from the subsequent fresh reset of the outgoing session. */
export function captureChatRuntime(host: ChatRuntimeHost): SessionChatRuntime {
  return {
    chatMessages: host.chatMessages,
    chatToolMessages: host.chatToolMessages,
    chatStreamSegments: host.chatStreamSegments,
    chatStream: host.chatStream,
    chatStreamStartedAt: host.chatStreamStartedAt,
    chatThinkingStream: host.chatThinkingStream,
    chatThinkingStreamStartedAt: host.chatThinkingStreamStartedAt,
    chatThinkingLevel: host.chatThinkingLevel,
    chatRunId: host.chatRunId,
    chatSending: host.chatSending,
    chatSendStartedAt: host.chatSendStartedAt,
    chatRunStatus: host.chatRunStatus,
    lastLocalTerminalReconcile: host.lastLocalTerminalReconcile,
    chatLoading: host.chatLoading,
    chatHistoryHasMore: host.chatHistoryHasMore,
    chatHistoryNextCursor: host.chatHistoryNextCursor,
    currentSessionId: host.currentSessionId,
    chatSideResult: host.chatSideResult,
    chatSideResultTerminalRuns: new Set(host.chatSideResultTerminalRuns),
    chatLiveUsage: host.chatLiveUsage,
    branchPoints: host.branchPoints,
    branchActivePath: host.branchActivePath,
    toolStreamById: new Map(host.toolStreamById),
    toolStreamOrder: host.toolStreamOrder,
  };
}

/** Restore a previously captured runtime onto the foreground state. */
export function applyChatRuntime(host: ChatRuntimeHost, runtime: SessionChatRuntime): void {
  host.chatMessages = runtime.chatMessages;
  host.chatToolMessages = runtime.chatToolMessages;
  host.chatStreamSegments = runtime.chatStreamSegments;
  host.chatStream = runtime.chatStream;
  host.chatStreamStartedAt = runtime.chatStreamStartedAt;
  host.chatThinkingStream = runtime.chatThinkingStream;
  host.chatThinkingStreamStartedAt = runtime.chatThinkingStreamStartedAt;
  host.chatThinkingLevel = runtime.chatThinkingLevel;
  host.chatRunId = runtime.chatRunId;
  host.chatSending = runtime.chatSending;
  host.chatSendStartedAt = runtime.chatSendStartedAt;
  host.chatRunStatus = runtime.chatRunStatus;
  host.lastLocalTerminalReconcile = runtime.lastLocalTerminalReconcile;
  host.chatLoading = runtime.chatLoading;
  host.chatHistoryHasMore = runtime.chatHistoryHasMore;
  host.chatHistoryNextCursor = runtime.chatHistoryNextCursor;
  host.currentSessionId = runtime.currentSessionId;
  host.chatSideResult = runtime.chatSideResult;
  host.chatSideResultTerminalRuns = runtime.chatSideResultTerminalRuns;
  host.chatLiveUsage = runtime.chatLiveUsage;
  host.branchPoints = runtime.branchPoints;
  host.branchActivePath = runtime.branchActivePath;
  host.toolStreamById = runtime.toolStreamById;
  host.toolStreamOrder = runtime.toolStreamOrder;
}

/** A runtime is worth retaining across a switch only while it has a live run
 *  (its result will still land) — a finished/idle session is cheaply rebuilt
 *  from history on return, so we drop it to bound the store. */
export function shouldRetainChatRuntime(runtime: SessionChatRuntime): boolean {
  return runtime.chatRunId !== null || runtime.chatSending || runtime.chatStream !== null;
}
