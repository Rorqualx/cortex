import type { ChatEvent } from "../../../../packages/gateway-protocol/src/index.js";
import { getChatAttachmentDataUrl } from "../chat/attachment-payload-store.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "../chat/heartbeat-display.ts";
import {
  CHAT_HISTORY_RENDER_LIMIT,
  CHAT_HISTORY_RENDER_EXPAND_STEP,
} from "../chat/history-limits.ts";
import { extractText } from "../chat/message-extract.ts";
import type { LocalTerminalReconcile } from "../chat/run-lifecycle.ts";
import { reconcileChatRunLifecycle } from "../chat/run-lifecycle.ts";
import type { SessionChatRuntime } from "../chat/session-runtime.ts";
import {
  appendTerminalAssistantMessage,
  clearToolStreamSegments,
  currentLiveToolCallIds,
  hasVisibleStreamParts,
  historyReplacedVisibleStream,
  materializeVisibleStreamState,
  maybeResetToolStream,
  persistedCurrentToolStreamIds,
  prunePersistedToolStreamMessages,
  visibleCurrentAssistantStreamTail,
} from "../chat/stream-reconciliation.ts";
import { buildUserChatMessageContentBlocks } from "../chat/user-message-content.ts";
import { formatConnectError } from "../connect-error.ts";
import {
  controlUiNowMs,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
} from "../control-ui-performance.ts";
import { GatewayRequestError, type GatewayBrowserClient, type GatewayHelloOk } from "../gateway.ts";
import {
  areUiSessionKeysEquivalent,
  canonicalizeBareUiSessionKey,
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type { AgentsListResult, GatewaySessionRow, GatewaySessionsDefaults } from "../types.ts";
import type { SessionBranchPoint } from "../types/chat-types.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
// Whole-history contract: ask for the server's full per-response window; any
// byte-bound remainder is auto-drained by drainEarlierMessages with no user
// interaction.
const CHAT_HISTORY_REQUEST_LIMIT = 10_000;
// Backstop only — each drained page covers up to 6MB / 10k messages, so real
// transcripts exhaust in a handful of iterations.
const CHAT_HISTORY_DRAIN_MAX_PAGES = 200;
const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;
const STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS = 500;
const STARTUP_CHAT_HISTORY_MAX_RETRY_MS = 5_000;
const chatHistoryRequestVersions = new WeakMap<object, number>();

function beginChatHistoryRequest(state: ChatState): number {
  const key = state as object;
  const nextVersion = (chatHistoryRequestVersions.get(key) ?? 0) + 1;
  chatHistoryRequestVersions.set(key, nextVersion);
  return nextVersion;
}

function isLatestChatHistoryRequest(state: ChatState, version: number): boolean {
  return chatHistoryRequestVersions.get(state as object) === version;
}

function currentChatHistoryVersion(state: ChatState): number {
  return chatHistoryRequestVersions.get(state as object) ?? 0;
}

function shouldApplyChatHistoryResult(
  state: ChatState,
  version: number,
  sessionKey: string,
  agentId?: string,
): boolean {
  if (!isLatestChatHistoryRequest(state, version) || state.sessionKey !== sessionKey) {
    return false;
  }
  return !isSelectedGlobalEventSessionKey(sessionKey) || resolveSelectedAgentId(state) === agentId;
}

function isSilentReplyStream(text: string): boolean {
  return SILENT_REPLY_PATTERN.test(text);
}

/** Client-side defense-in-depth: detect assistant messages whose text is purely NO_REPLY. */
function isAssistantSilentReply(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "assistant") {
    return false;
  }
  // entry.text takes precedence — matches gateway extractAssistantTextForSilentCheck
  if (typeof entry.text === "string") {
    return isSilentReplyStream(entry.text);
  }
  const text = extractText(message);
  return typeof text === "string" && isSilentReplyStream(text);
}

function isSyntheticTranscriptRepairToolResult(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "toolresult") {
    return false;
  }
  const text = extractText(message);
  return typeof text === "string" && text.trim() === SYNTHETIC_TRANSCRIPT_REPAIR_RESULT;
}

function isTextOnlyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  if (content.length === 0) {
    return true;
  }
  let sawText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type !== "text") {
      return false;
    }
    sawText = true;
    if (typeof entry.text !== "string") {
      return false;
    }
  }
  return sawText;
}

function isEmptyUserTextOnlyMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (normalizeLowercaseStringOrEmpty(entry.role) !== "user") {
    return false;
  }
  const mediaPaths = Array.isArray(entry.MediaPaths)
    ? entry.MediaPaths
    : typeof entry.MediaPath === "string"
      ? [entry.MediaPath]
      : [];
  if (mediaPaths.some((value) => typeof value === "string" && value.trim())) {
    return false;
  }
  if (!isTextOnlyContent(entry.content ?? entry.text)) {
    return false;
  }
  return (extractText(message)?.trim() ?? "") === "";
}

function isHeartbeatAckStream(text: string): boolean {
  return stripHeartbeatTokenForDisplay(text).shouldSkip;
}

function shouldHideAssistantChatMessage(message: unknown): boolean {
  return isAssistantSilentReply(message) || isAssistantHeartbeatAckForDisplay(message);
}

function shouldHideHistoryMessage(message: unknown): boolean {
  return (
    shouldHideAssistantChatMessage(message) ||
    isSyntheticTranscriptRepairToolResult(message) ||
    isEmptyUserTextOnlyMessage(message)
  );
}

function isHiddenAssistantStreamText(text: string): boolean {
  return isSilentReplyStream(text) || isHeartbeatAckStream(text);
}

function materializeVisibleAssistantStreamMessages(
  messages: unknown[],
  state: ChatState,
  opts: {
    includeCurrent?: boolean;
    requirePersistedTool?: boolean;
    replacementMessages?: unknown[];
  } = {},
): unknown[] {
  return materializeVisibleStreamState(messages, state, {
    ...opts,
    isHiddenAssistantMessage: shouldHideAssistantChatMessage,
    isHiddenStreamText: isHiddenAssistantStreamText,
  });
}

function hasTranscriptMeta(message: unknown): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { __openclaw?: unknown })["__openclaw"] &&
    typeof (message as { __openclaw?: unknown })["__openclaw"] === "object",
  );
}

function isLocallyOptimisticHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || hasTranscriptMeta(message)) {
    return false;
  }
  const role = normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role);
  return role === "user" || role === "assistant";
}

function messageDisplaySignature(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const role = normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role);
  if (!role) {
    return null;
  }
  const text = extractText(message)?.trim();
  if (text) {
    return `${role}:text:${text}`;
  }
  try {
    const content = JSON.stringify((message as { content?: unknown }).content ?? null);
    return `${role}:content:${content}`;
  } catch {
    return null;
  }
}

function messageTimestampMs(message: unknown): number | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const timestamp = (message as { timestamp?: unknown; ts?: unknown }).timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp;
  }
  const ts = (message as { timestamp?: unknown; ts?: unknown }).ts;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

function historyHasSameOrNewerDisplayMessage(
  historyMessages: unknown[],
  signature: string,
  message: unknown,
): boolean {
  const timestamp = messageTimestampMs(message);
  if (timestamp == null) {
    return false;
  }
  return historyMessages.some((historyMessage) => {
    if (messageDisplaySignature(historyMessage) !== signature) {
      return false;
    }
    const historyTimestamp = messageTimestampMs(historyMessage);
    return historyTimestamp != null && historyTimestamp >= timestamp;
  });
}

export function preserveOptimisticTailMessages(
  historyMessages: unknown[],
  previousMessages: unknown[],
): unknown[] {
  if (previousMessages.length === 0) {
    return historyMessages;
  }
  if (historyMessages.length === 0) {
    const optimisticMessages = previousMessages.filter(
      (message) => isLocallyOptimisticHistoryMessage(message) && !shouldHideHistoryMessage(message),
    );
    return optimisticMessages.length === previousMessages.length
      ? previousMessages
      : historyMessages;
  }
  const historySignatureIndexes = new Map<string, number>();
  historyMessages.forEach((message, index) => {
    const signature = messageDisplaySignature(message);
    if (signature) {
      historySignatureIndexes.set(signature, index);
    }
  });
  let sharedPreviousIndex = -1;
  let sharedHistoryIndex = -1;
  for (let index = previousMessages.length - 1; index >= 0; index--) {
    const signature = messageDisplaySignature(previousMessages[index]);
    const historyIndex = signature ? historySignatureIndexes.get(signature) : undefined;
    if (typeof historyIndex === "number") {
      sharedPreviousIndex = index;
      sharedHistoryIndex = historyIndex;
      break;
    }
  }
  if (sharedPreviousIndex < 0) {
    return historyMessages;
  }
  if (sharedHistoryIndex < historyMessages.length - 1) {
    return historyMessages;
  }
  const optimisticTail: unknown[] = [];
  for (const message of previousMessages.slice(sharedPreviousIndex + 1)) {
    if (!isLocallyOptimisticHistoryMessage(message) || shouldHideHistoryMessage(message)) {
      return historyMessages;
    }
    const signature = messageDisplaySignature(message);
    if (!signature || historySignatureIndexes.has(signature)) {
      return historyMessages;
    }
    optimisticTail.push(message);
  }
  return optimisticTail.length > 0 ? [...historyMessages, ...optimisticTail] : historyMessages;
}

function collectLateOptimisticTailMessages(
  previousMessages: unknown[],
  currentMessages: unknown[],
  historyMessages: unknown[],
): unknown[] {
  if (currentMessages === previousMessages || currentMessages.length <= previousMessages.length) {
    return [];
  }
  if (previousMessages.some((message, index) => currentMessages[index] !== message)) {
    return [];
  }
  const lateTail: unknown[] = [];
  for (const message of currentMessages.slice(previousMessages.length)) {
    if (!isLocallyOptimisticHistoryMessage(message) || shouldHideHistoryMessage(message)) {
      return [];
    }
    const signature = messageDisplaySignature(message);
    if (!signature) {
      return [];
    }
    if (historyHasSameOrNewerDisplayMessage(historyMessages, signature, message)) {
      continue;
    }
    lateTail.push(message);
  }
  return lateTail;
}

function isRetryableStartupUnavailable(err: unknown, method: string): err is GatewayRequestError {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  if (err.gatewayCode !== "UNAVAILABLE" || !err.retryable) {
    return false;
  }
  const details = err.details;
  if (!details || typeof details !== "object") {
    return true;
  }
  const detailMethod = (details as { method?: unknown }).method;
  return typeof detailMethod !== "string" || detailMethod === method;
}

function isUnknownGatewayMethodError(err: unknown, method: string): err is GatewayRequestError {
  return (
    err instanceof GatewayRequestError &&
    err.gatewayCode === "INVALID_REQUEST" &&
    err.message.includes(`unknown method: ${method}`)
  );
}

export function isGatewayMethodAdvertised(state: ChatState, method: string): boolean | null {
  const methods = state.hello?.features?.methods;
  if (!Array.isArray(methods)) {
    return null;
  }
  return methods.includes(method);
}

function resolveStartupRetryDelayMs(err: GatewayRequestError): number {
  const retryAfterMs =
    typeof err.retryAfterMs === "number" ? err.retryAfterMs : STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS;
  return Math.min(Math.max(retryAfterMs, 100), STARTUP_CHAT_HISTORY_MAX_RETRY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  currentSessionId?: string | null;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatSendStartedAt: number | null;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatThinkingStream: string | null;
  chatThinkingStreamStartedAt: number | null;
  chatHistoryHasMore: boolean;
  chatHistoryNextOffset: number | null;
  chatLoadingEarlier: boolean;
  chatHistoryRenderLimit: number;
  chatHistoryRenderExpanded: boolean;
  lastError: string | null;
  chatError?: string | null;
  agentsError?: string | null;
  resetChatInputHistoryNavigation?: () => void;
  assistantAgentId?: string | null;
  agentsList?: ChatAgentsListSnapshot | null;
  agentsSelectedId?: string | null;
  hello?: GatewayHelloOk | null;
  /** Branch points from chat.branches for visual navigation. */
  branchPoints?: SessionBranchPoint[];
  /** Active branch path (root→leaf entry IDs) from chat.branches. */
  branchActivePath?: string[];
  /** Currently active branch entry ID (for branch navigation). */
  branchFromId?: string | null;
  // Written by run-lifecycle terminal reconcile; delta handling reads it to keep a
  // late delta from re-opening a stream the user already saw finish.
  lastLocalTerminalReconcile?: LocalTerminalReconcile | null;
  /** Epoch ms when chat.history was last successfully applied. Guards redundant reloads. */
  chatHistoryLastAppliedAt?: number;
};

type ChatAgentsListSnapshot = Partial<Omit<AgentsListResult, "agents">> & {
  agents?: Array<{ id: string }>;
};

export type ChatHistoryResult = {
  messages?: Array<unknown>;
  sessionId?: string;
  thinkingLevel?: string;
  defaults?: GatewaySessionsDefaults;
  sessionInfo?: GatewaySessionRow;
  agentsList?: AgentsListResult;
  hasMore?: boolean;
  nextOffset?: number;
};

// Wire-contract union for "chat" gateway events; the single source is
// ChatEventSchema in gateway-protocol, shared with the server emit seam.
export type ChatEventPayload = ChatEvent;

function setChatError(state: ChatState, error: string | null) {
  state.lastError = error;
  state.chatError = error;
}

function isGlobalSessionKey(sessionKey: string | undefined | null): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  return normalized === "global";
}

function isSelectedGlobalEventSessionKey(sessionKey: string | undefined | null): boolean {
  if (isGlobalSessionKey(sessionKey)) {
    return true;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeLowercaseStringOrEmpty(parsed?.rest) === "main";
}

function resolveSelectedAgentId(state: ChatState): string | undefined {
  const parsed = parseAgentSessionKey(state.sessionKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  const assistantAgentId =
    typeof state.assistantAgentId === "string" && state.assistantAgentId.trim()
      ? state.assistantAgentId
      : undefined;
  const defaultAgentId =
    typeof state.agentsList?.defaultId === "string" && state.agentsList.defaultId.trim()
      ? state.agentsList.defaultId
      : undefined;
  const helloDefaultAgentId =
    typeof snapshot?.sessionDefaults?.defaultAgentId === "string" &&
    snapshot.sessionDefaults.defaultAgentId.trim()
      ? snapshot.sessionDefaults.defaultAgentId
      : undefined;
  const selectedAgentId = assistantAgentId ?? defaultAgentId ?? helloDefaultAgentId;
  return selectedAgentId ? normalizeAgentId(selectedAgentId) : undefined;
}

function resolveDefaultAgentId(state: ChatState): string | undefined {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  const agentId =
    typeof state.agentsList?.defaultId === "string" && state.agentsList.defaultId.trim()
      ? state.agentsList.defaultId
      : typeof snapshot?.sessionDefaults?.defaultAgentId === "string" &&
          snapshot.sessionDefaults.defaultAgentId.trim()
        ? snapshot.sessionDefaults.defaultAgentId
        : undefined;
  return agentId ? normalizeAgentId(agentId) : undefined;
}

function chatEventAgentScopeMatches(state: ChatState, payload: ChatEventPayload): boolean {
  if (
    !isSelectedGlobalEventSessionKey(state.sessionKey) ||
    !isGlobalSessionKey(payload.sessionKey)
  ) {
    return true;
  }
  const payloadAgentId =
    typeof payload.agentId === "string" && payload.agentId.trim()
      ? normalizeAgentId(payload.agentId)
      : undefined;
  const selectedAgentId = resolveSelectedAgentId(state);
  return payloadAgentId
    ? selectedAgentId !== undefined && payloadAgentId === selectedAgentId
    : selectedAgentId === undefined || selectedAgentId === resolveDefaultAgentId(state);
}

function chatEventSessionMatches(state: ChatState, payload: ChatEventPayload): boolean {
  // A `?session=foo` deep link stores the raw "foo" as the selected key, but the
  // gateway broadcasts the canonical agent-scoped form ("agent:<default>:foo").
  // Match against both so out-of-band finals (steered follow-up turns, sub-agent
  // announces) are not dropped for a session selected by a bare key.
  const canonicalSelected = canonicalizeBareUiSessionKey(
    state.sessionKey,
    resolveDefaultAgentId(state) ?? DEFAULT_AGENT_ID,
  );
  if (
    areUiSessionKeysEquivalent(payload.sessionKey, state.sessionKey) ||
    areUiSessionKeysEquivalent(payload.sessionKey, canonicalSelected)
  ) {
    return chatEventAgentScopeMatches(state, payload);
  }
  return (
    isGlobalSessionKey(payload.sessionKey) &&
    isSelectedGlobalEventSessionKey(state.sessionKey) &&
    chatEventAgentScopeMatches(state, payload)
  );
}

type ChatDeltaEventPayload = Extract<ChatEventPayload, { state: "delta" }>;
type ChatErrorEventPayload = Extract<ChatEventPayload, { state: "error" }>;

function resolveDeltaChatStreamText(
  currentStream: string | null,
  payload: ChatDeltaEventPayload,
): string | null {
  const snapshot = payload.message == null ? null : extractText(payload.message);
  if (typeof payload.deltaText === "string") {
    if (payload.replace === true) {
      return payload.deltaText;
    }
    if (currentStream === null) {
      return typeof snapshot === "string" ? snapshot : payload.deltaText;
    }
    if (typeof snapshot === "string") {
      const prefixLength = snapshot.length - payload.deltaText.length;
      if (
        prefixLength !== currentStream.length ||
        snapshot.slice(0, prefixLength) !== currentStream
      ) {
        return snapshot;
      }
    }
    return `${currentStream}${payload.deltaText}`;
  }
  return typeof snapshot === "string" ? snapshot : null;
}

function resolveDeltaThinkingStreamText(
  currentStream: string | null,
  payload: ChatDeltaEventPayload,
): string | null {
  if (typeof payload.deltaThinking === "string") {
    if (payload.replace === true) {
      return payload.deltaThinking;
    }
    if (currentStream === null) {
      return payload.deltaThinking;
    }
    return `${currentStream}${payload.deltaThinking}`;
  }
  return currentStream;
}

type InFlightChatHistoryRequest = {
  client: NonNullable<ChatState["client"]>;
  key: string;
  messages: unknown[];
  promise: Promise<ChatHistoryResult | undefined>;
};

type LoadChatHistoryOptions = {
  startup?: boolean;
};

const inFlightChatHistoryRequests = new WeakMap<ChatState, InFlightChatHistoryRequest>();

// Serialize branch navigation per session: chat.branch only clears branchPoints
// after its await, so without this a second rapid prev/next click would recompute
// the target from the same stale activeChildId and land on the wrong sibling.
const branchNavigateInFlight = new WeakSet<ChatState>();

function recordChatHistoryTiming(
  state: ChatState,
  phase: "start" | "applied" | "stream-reset" | "stale" | "error",
  startedAtMs: number,
  extra: Record<string, unknown> = {},
) {
  recordControlUiPerformanceEvent(
    state as ChatState & Parameters<typeof recordControlUiPerformanceEvent>[0],
    "control-ui.chat.history",
    {
      phase,
      durationMs: roundedControlUiDurationMs(controlUiNowMs() - startedAtMs),
      sessionKey: state.sessionKey,
      activeRunId: state.chatRunId,
      ...extra,
    },
    { console: false, maxBufferedEventsForType: 30 },
  );
}

export async function loadChatHistory(
  state: ChatState,
  opts: LoadChatHistoryOptions = {},
): Promise<ChatHistoryResult | undefined> {
  if (!state.client || !state.connected) {
    return undefined;
  }
  const sessionKey = state.sessionKey;
  const requestAgentId = isSelectedGlobalEventSessionKey(sessionKey)
    ? resolveSelectedAgentId(state)
    : undefined;
  const startupAdvertised = isGatewayMethodAdvertised(state, "chat.startup");
  const method =
    opts.startup === true && startupAdvertised !== false ? "chat.startup" : "chat.history";
  const requestKey = `${method}\0${sessionKey}\0${requestAgentId ?? ""}`;
  const inFlight = inFlightChatHistoryRequests.get(state);
  if (
    inFlight?.key === requestKey &&
    inFlight.client === state.client &&
    inFlight.messages === state.chatMessages
  ) {
    return inFlight.promise;
  }
  const promise = loadChatHistoryUncached(
    state,
    state.client,
    sessionKey,
    requestAgentId,
    method,
  ).finally(() => {
    if (inFlightChatHistoryRequests.get(state)?.promise === promise) {
      inFlightChatHistoryRequests.delete(state);
    }
  });
  inFlightChatHistoryRequests.set(state, {
    client: state.client,
    key: requestKey,
    messages: state.chatMessages,
    promise,
  });
  return promise;
}

function applyChatStartupAgentsList(state: ChatState, agentsList: AgentsListResult | undefined) {
  if (!agentsList) {
    return;
  }
  state.agentsList = agentsList;
  state.agentsError = null;
  const selectedId =
    typeof state.agentsSelectedId === "string" && state.agentsSelectedId.trim()
      ? normalizeAgentId(state.agentsSelectedId)
      : undefined;
  if (selectedId && agentsList.agents.some((entry) => normalizeAgentId(entry.id) === selectedId)) {
    return;
  }
  state.agentsSelectedId =
    typeof agentsList.defaultId === "string" && agentsList.defaultId.trim()
      ? agentsList.defaultId
      : (agentsList.agents[0]?.id ?? null);
}

export async function loadEarlierMessages(state: ChatState): Promise<boolean> {
  if (
    !state.client ||
    !state.connected ||
    state.chatLoadingEarlier ||
    state.chatHistoryNextOffset === null
  ) {
    return false;
  }
  state.chatLoadingEarlier = true;
  try {
    const offset = state.chatHistoryNextOffset;
    const sessionKey = state.sessionKey;
    const historyVersion = currentChatHistoryVersion(state);
    const requestAgentId = isSelectedGlobalEventSessionKey(sessionKey)
      ? resolveSelectedAgentId(state)
      : undefined;
    const res = await state.client.request<ChatHistoryResult>("chat.history", {
      sessionKey,
      ...(requestAgentId ? { agentId: requestAgentId } : {}),
      limit: CHAT_HISTORY_REQUEST_LIMIT,
      offset,
    });
    // Discard if the session changed or a newer full history load started:
    // a page belongs to the pagination chain of the load that produced its
    // cursor, and applying it would prepend stale messages and regress
    // chatHistoryNextOffset onto the old chain.
    if (state.sessionKey !== sessionKey || currentChatHistoryVersion(state) !== historyVersion) {
      return false;
    }
    const messages = Array.isArray(res.messages) ? res.messages : [];
    const visibleMessages = messages.filter((message) => !shouldHideHistoryMessage(message));
    // Prepend earlier messages before the current ones.
    if (visibleMessages.length > 0) {
      state.chatMessages = [...visibleMessages, ...state.chatMessages];
    }
    state.chatHistoryHasMore = res.hasMore === true;
    state.chatHistoryNextOffset = res.nextOffset ?? null;
    return visibleMessages.length > 0;
  } catch (err) {
    setChatError(state, String(err));
    return false;
  } finally {
    state.chatLoadingEarlier = false;
  }
}

/** Pull every remaining older page until the transcript start, no user action. */
async function drainEarlierMessages(state: ChatState, sessionKey: string): Promise<void> {
  // A drain serves exactly one applied history load; a newer load resets the
  // cursor chain and spawns its own drain, so this one must stop.
  const historyVersion = currentChatHistoryVersion(state);
  for (let page = 0; page < CHAT_HISTORY_DRAIN_MAX_PAGES; page += 1) {
    if (
      state.sessionKey !== sessionKey ||
      currentChatHistoryVersion(state) !== historyVersion ||
      !state.chatHistoryHasMore ||
      state.chatHistoryNextOffset === null
    ) {
      return;
    }
    const loaded = await loadEarlierMessages(state);
    if (!loaded) {
      return;
    }
  }
}

export function expandHistoryRenderLimit(state: ChatState): boolean {
  const messagesCount = Array.isArray(state.chatMessages) ? state.chatMessages.length : 0;
  const currentLimit = state.chatHistoryRenderLimit;
  if (currentLimit >= messagesCount) {
    return false;
  }
  state.chatHistoryRenderLimit = Math.min(
    currentLimit + CHAT_HISTORY_RENDER_EXPAND_STEP,
    messagesCount,
  );
  state.chatHistoryRenderExpanded = true;
  return state.chatHistoryRenderLimit > currentLimit;
}

export async function loadBranches(state: ChatState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  const requestedSessionKey = state.sessionKey;
  // Forward the selected agent for global session keys, mirroring the history
  // path; without it the gateway resolves the wrong agent and returns no
  // branches, so the navigator's dividers never render.
  const requestAgentId = isSelectedGlobalEventSessionKey(requestedSessionKey)
    ? resolveSelectedAgentId(state)
    : undefined;
  try {
    const res = await state.client.request<{
      ok?: boolean;
      branches?: SessionBranchPoint[];
      activeLeafId?: string | null;
      activePath?: string[];
      error?: string;
    }>("chat.branches", {
      sessionKey: requestedSessionKey,
      ...(requestAgentId ? { agentId: requestAgentId } : {}),
    });
    // Drop a response that resolved after the user switched away, so one
    // session's branch dividers never render on another's transcript.
    if (state.sessionKey !== requestedSessionKey) {
      return;
    }
    if (res.ok && res.branches) {
      state.branchPoints = res.branches;
      state.branchActivePath = res.activePath ?? [];
    } else {
      clearBranchStateIfPresent(state);
    }
  } catch {
    if (state.sessionKey !== requestedSessionKey) {
      return;
    }
    clearBranchStateIfPresent(state);
  }
}

// A branch-less conversation already has empty branch state from the session
// reset; assigning a fresh [] over it busts the chat-items reference cache and
// repaints the whole transcript for nothing on every switch. Only clear when
// there is actually something to clear.
function clearBranchStateIfPresent(state: ChatState): void {
  if ((state.branchPoints?.length ?? 0) === 0 && (state.branchActivePath?.length ?? 0) === 0) {
    return;
  }
  state.branchPoints = [];
  state.branchActivePath = [];
}

export async function handleBranchNavigate(
  state: ChatState,
  entryId: string,
  direction: "prev" | "next",
): Promise<void> {
  if (!state.client || !state.connected || branchNavigateInFlight.has(state)) {
    return;
  }
  // Resolve the sibling to switch to from the branch point's child order. The
  // counter cycles childIds; "select" resumes that sibling's existing branch
  // (its deepest leaf) instead of starting an empty one.
  const branchPoint = (state.branchPoints ?? []).find((bp) => bp.entryId === entryId);
  if (!branchPoint || branchPoint.activeChildId === null) {
    return;
  }
  const currentIndex = branchPoint.childIds.indexOf(branchPoint.activeChildId);
  if (currentIndex === -1) {
    return;
  }
  const count = branchPoint.childIds.length;
  const targetIndex =
    direction === "next" ? (currentIndex + 1) % count : (currentIndex - 1 + count) % count;
  const targetChildId = branchPoint.childIds[targetIndex];
  // Same agent scoping as loadBranches: a global session key must carry the
  // selected agent or the gateway resolves the wrong session for the switch.
  const requestAgentId = isSelectedGlobalEventSessionKey(state.sessionKey)
    ? resolveSelectedAgentId(state)
    : undefined;
  branchNavigateInFlight.add(state);
  try {
    const res = await state.client.request<{
      ok?: boolean;
      branchFromId?: string;
      error?: string;
    }>("chat.branch", {
      sessionKey: state.sessionKey,
      ...(requestAgentId ? { agentId: requestAgentId } : {}),
      entryId: targetChildId,
      mode: "select",
    });
    if (res.ok) {
      state.branchFromId = targetChildId;
      state.branchPoints = [];
      state.branchActivePath = [];
      await Promise.all([loadChatHistory(state, { startup: false }), loadBranches(state)]);
    }
  } catch {
    // Silently fail — branch not supported on older gateways
  } finally {
    branchNavigateInFlight.delete(state);
  }
}

async function loadChatHistoryUncached(
  state: ChatState,
  client: NonNullable<ChatState["client"]>,
  sessionKey: string,
  requestAgentId: string | undefined,
  method: "chat.history" | "chat.startup",
): Promise<ChatHistoryResult | undefined> {
  const requestVersion = beginChatHistoryRequest(state);
  const startedAt = Date.now();
  const startedAtMs = controlUiNowMs();
  const previousMessages = state.chatMessages;
  const previousRunId = state.chatRunId;
  recordChatHistoryTiming(state, "start", startedAtMs, {
    requestSessionKey: sessionKey,
    requestAgentId,
    method,
    previousRunId,
  });
  // Any pending input-history snapshot becomes invalid once we start reloading transcript state.
  state.resetChatInputHistoryNavigation?.();
  state.chatLoading = true;
  setChatError(state, null);
  try {
    let res: ChatHistoryResult;
    for (;;) {
      try {
        res = await client.request<ChatHistoryResult>(method, {
          sessionKey,
          ...(requestAgentId ? { agentId: requestAgentId } : {}),
          limit: CHAT_HISTORY_REQUEST_LIMIT,
        });
        break;
      } catch (err) {
        if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey, requestAgentId)) {
          recordChatHistoryTiming(state, "stale", startedAtMs, {
            requestSessionKey: sessionKey,
            requestAgentId,
            previousRunId,
            reason: "request-version",
          });
          return undefined;
        }
        const withinStartupRetryWindow =
          Date.now() - startedAt < STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS;
        if (method === "chat.startup" && isUnknownGatewayMethodError(err, method)) {
          res = await client.request<ChatHistoryResult>("chat.history", {
            sessionKey,
            ...(requestAgentId ? { agentId: requestAgentId } : {}),
            limit: CHAT_HISTORY_REQUEST_LIMIT,
          });
          break;
        }
        if (withinStartupRetryWindow && isRetryableStartupUnavailable(err, method)) {
          await sleep(resolveStartupRetryDelayMs(err));
          if (!state.client || !state.connected) {
            return undefined;
          }
          continue;
        }
        throw err;
      }
    }
    if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey, requestAgentId)) {
      recordChatHistoryTiming(state, "stale", startedAtMs, {
        requestSessionKey: sessionKey,
        requestAgentId,
        previousRunId,
        reason: "apply-version",
      });
      return undefined;
    }
    const messages = Array.isArray(res.messages) ? res.messages : [];
    applyChatStartupAgentsList(state, res.agentsList);
    // Persisted history wins over live stream text: the reconciliation block
    // below (historyReplacedVisibleStream) clears the stream when history
    // already contains it, so duplicates are resolved stream-side, not by
    // stripping persisted messages.
    const visibleMessages = messages.filter((message) => !shouldHideHistoryMessage(message));
    const lateOptimisticTail = collectLateOptimisticTailMessages(
      previousMessages,
      state.chatMessages,
      visibleMessages,
    );
    state.chatMessages = preserveOptimisticTailMessages(visibleMessages, previousMessages);
    if (lateOptimisticTail.length > 0) {
      state.chatMessages = [...state.chatMessages, ...lateOptimisticTail];
    }
    state.currentSessionId =
      typeof res.sessionInfo?.sessionId === "string" && res.sessionInfo.sessionId.trim()
        ? res.sessionInfo.sessionId
        : typeof res.sessionId === "string" && res.sessionId.trim()
          ? res.sessionId
          : null;
    state.chatThinkingLevel = res.sessionInfo?.thinkingLevel ?? res.thinkingLevel ?? null;
    // Track pagination state from server response.
    state.chatHistoryHasMore = res.hasMore === true;
    state.chatHistoryNextOffset = res.nextOffset ?? null;
    state.chatHistoryRenderLimit = CHAT_HISTORY_RENDER_LIMIT;
    state.chatHistoryRenderExpanded = false;
    if (state.chatHistoryHasMore) {
      void drainEarlierMessages(state, sessionKey);
    }
    const resetStream = !state.chatRunId || state.chatRunId === previousRunId;
    if (resetStream) {
      const streamReconciliation = {
        isHiddenAssistantMessage: shouldHideAssistantChatMessage,
        isHiddenStreamText: isHiddenAssistantStreamText,
      };
      const hasVisibleStream = hasVisibleStreamParts(state, streamReconciliation);
      const historyReplacedStream = historyReplacedVisibleStream(
        state.chatMessages,
        state,
        streamReconciliation,
      );
      const liveToolIds = currentLiveToolCallIds(state);
      const persistedToolStreamIds = persistedCurrentToolStreamIds(state.chatMessages, state);
      const historyReplacedToolStream =
        liveToolIds.length > 0 && liveToolIds.every((id) => persistedToolStreamIds.has(id));
      const historyReplacedSomeToolStream = persistedToolStreamIds.size > 0;
      const liveToolStreamReplaced = liveToolIds.length === 0 || historyReplacedToolStream;
      // An empty/hidden stream during a still-active run is the live thinking
      // indicator; a racing history reload must not clear it — the run delivers
      // its own terminal event.
      const indicatorOnlyActiveStream =
        typeof state.chatStream === "string" && state.chatRunId !== null && !hasVisibleStream;
      if (indicatorOnlyActiveStream) {
        // Keep the stream alive for the active run.
      } else if (!hasVisibleStream || historyReplacedStream) {
        if (liveToolStreamReplaced) {
          // Clear all streaming state — history includes tool results and text
          // inline, so keeping streaming artifacts would cause duplicates.
          maybeResetToolStream(state);
        } else {
          prunePersistedToolStreamMessages(state, persistedToolStreamIds);
          clearToolStreamSegments(state);
        }
        state.chatStream = null;
        state.chatStreamStartedAt = null;
        state.chatThinkingStream = null;
        state.chatThinkingStreamStartedAt = null;
      } else if (!state.chatRunId) {
        state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state);
        maybeResetToolStream(state);
        state.chatStream = null;
        state.chatStreamStartedAt = null;
        state.chatThinkingStream = null;
        state.chatThinkingStreamStartedAt = null;
      } else if (historyReplacedToolStream) {
        state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
          includeCurrent: false,
        });
        state.chatStream = visibleCurrentAssistantStreamTail(
          state,
          streamReconciliation.isHiddenStreamText,
        );
        if (state.chatStream === null) {
          state.chatStreamStartedAt = null;
        }
        maybeResetToolStream(state);
      } else if (historyReplacedSomeToolStream) {
        const visibleCurrentTail = visibleCurrentAssistantStreamTail(
          state,
          streamReconciliation.isHiddenStreamText,
        );
        state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
          includeCurrent: false,
          requirePersistedTool: true,
        });
        state.chatStream = visibleCurrentTail;
        if (state.chatStream === null) {
          state.chatStreamStartedAt = null;
        }
        prunePersistedToolStreamMessages(state, persistedToolStreamIds);
      }
      recordChatHistoryTiming(state, "stream-reset", startedAtMs, {
        requestSessionKey: sessionKey,
        requestAgentId,
        previousRunId,
        messageCount: messages.length,
        visibleMessageCount: visibleMessages.length,
      });
    }
    recordChatHistoryTiming(state, "applied", startedAtMs, {
      requestSessionKey: sessionKey,
      requestAgentId,
      previousRunId,
      messageCount: messages.length,
      visibleMessageCount: visibleMessages.length,
      resetStream,
    });
    state.chatHistoryLastAppliedAt = Date.now();
    return res;
  } catch (err) {
    if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey, requestAgentId)) {
      recordChatHistoryTiming(state, "stale", startedAtMs, {
        requestSessionKey: sessionKey,
        requestAgentId,
        previousRunId,
        reason: "error-version",
      });
      return undefined;
    }
    recordChatHistoryTiming(state, "error", startedAtMs, {
      requestSessionKey: sessionKey,
      requestAgentId,
      previousRunId,
    });
    if (isMissingOperatorReadScopeError(err)) {
      state.chatMessages = [];
      state.chatThinkingLevel = null;
      setChatError(state, formatMissingOperatorReadScopeMessage("existing chat history"));
    } else {
      setChatError(state, String(err));
    }
  } finally {
    if (isLatestChatHistoryRequest(state, requestVersion)) {
      state.chatLoading = false;
    }
  }
  return undefined;
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  const mimeType = match?.[1];
  const content = match?.[2];
  if (mimeType === undefined || content === undefined) {
    return null;
  }
  return { mimeType, content };
}

function buildApiAttachments(attachments?: ChatAttachment[]) {
  const hasAttachments = attachments && attachments.length > 0;
  return hasAttachments
    ? attachments
        .map((att) => {
          const dataUrl = getChatAttachmentDataUrl(att);
          const parsed = dataUrl ? dataUrlToBase64(dataUrl) : null;
          if (!parsed) {
            return null;
          }
          return {
            type: parsed.mimeType.startsWith("image/") ? "image" : "file",
            mimeType: parsed.mimeType,
            fileName: att.fileName,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;
}

export type ChatSendAckStatus = "started" | "in_flight" | "ok";

export type ChatSendAckServerTiming = {
  receivedToAckMs?: number;
  loadSessionMs?: number;
  prepareAttachmentsMs?: number;
};

export type ChatSendAck = {
  runId: string;
  status: ChatSendAckStatus;
  serverTiming?: ChatSendAckServerTiming;
};

function normalizeAckTimingValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeChatSendAckServerTiming(value: unknown): ChatSendAckServerTiming | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const receivedToAckMs = normalizeAckTimingValue(record.receivedToAckMs);
  const loadSessionMs = normalizeAckTimingValue(record.loadSessionMs);
  const prepareAttachmentsMs = normalizeAckTimingValue(record.prepareAttachmentsMs);
  const timing: ChatSendAckServerTiming = {
    ...(receivedToAckMs !== undefined ? { receivedToAckMs } : {}),
    ...(loadSessionMs !== undefined ? { loadSessionMs } : {}),
    ...(prepareAttachmentsMs !== undefined ? { prepareAttachmentsMs } : {}),
  };
  return Object.keys(timing).length > 0 ? timing : undefined;
}

function normalizeChatSendAck(payload: unknown, fallbackRunId: string): ChatSendAck {
  if (!payload || typeof payload !== "object") {
    return { runId: fallbackRunId, status: "started" };
  }
  const record = payload as Record<string, unknown>;
  const runId =
    typeof record.runId === "string" && record.runId.trim() ? record.runId.trim() : fallbackRunId;
  const status = record.status;
  const serverTiming = normalizeChatSendAckServerTiming(record.serverTiming);
  return {
    runId,
    status: status === "in_flight" || status === "ok" ? status : "started",
    ...(serverTiming ? { serverTiming } : {}),
  };
}

export async function requestChatSend(
  state: ChatState,
  params: {
    message: string;
    attachments?: ChatAttachment[];
    runId: string;
    sessionKey?: string;
    agentId?: string;
  },
): Promise<ChatSendAck> {
  const routing = resolveChatSendRouting(state, params);
  const payload = await state.client!.request("chat.send", {
    sessionKey: routing.sessionKey,
    ...(isGlobalSessionKey(routing.sessionKey) && routing.selectedAgentId
      ? { agentId: routing.selectedAgentId }
      : {}),
    ...(routing.sessionId ? { sessionId: routing.sessionId } : {}),
    message: params.message,
    deliver: false,
    idempotencyKey: params.runId,
    attachments: buildApiAttachments(params.attachments),
  });
  return normalizeChatSendAck(payload, params.runId);
}

function resolveChatSendRouting(
  state: ChatState,
  params: {
    sessionKey?: string;
    agentId?: string;
  },
): { selectedAgentId?: string; sessionId?: string; sessionKey: string } {
  const sessionKey = params.sessionKey ?? state.sessionKey;
  const selectedAgentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : resolveSelectedAgentId(state);
  const currentSessionId = state.currentSessionId;
  const canReuseCurrentSessionId =
    sessionKey === state.sessionKey &&
    (!isGlobalSessionKey(sessionKey) ||
      (selectedAgentId !== undefined && selectedAgentId === resolveSelectedAgentId(state)));
  const sessionId =
    canReuseCurrentSessionId && typeof currentSessionId === "string" && currentSessionId.trim()
      ? currentSessionId.trim()
      : undefined;
  return {
    sessionKey,
    ...(selectedAgentId ? { selectedAgentId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

function normalizeAssistantMessage(
  message: unknown,
  options: AssistantMessageNormalizationOptions,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const roleValue = candidate.role;
  if (typeof roleValue === "string") {
    const role = options.roleCaseSensitive ? roleValue : normalizeLowercaseStringOrEmpty(roleValue);
    if (role !== "assistant") {
      return null;
    }
  } else if (options.roleRequirement === "required") {
    return null;
  }

  if (options.requireContentArray) {
    return Array.isArray(candidate.content) ? candidate : null;
  }
  if (!("content" in candidate) && !(options.allowTextField && "text" in candidate)) {
    return null;
  }
  return candidate;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "required",
    roleCaseSensitive: true,
    requireContentArray: true,
  });
}

function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
}

function buildErrorAssistantMessage(
  payload: ChatErrorEventPayload,
): Record<string, unknown> | null {
  const normalized = normalizeFinalAssistantMessage(payload.message);
  if (normalized && !shouldHideAssistantChatMessage(normalized)) {
    return normalized;
  }
  const error = payload.errorMessage?.trim();
  if (!error) {
    return null;
  }
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: error.startsWith("⚠️") || error.startsWith("Error:") ? error : `Error: ${error}`,
      },
    ],
    timestamp: Date.now(),
  };
}

// Stable idempotency key for an edit/resend of a given transcript entry. Reusing
// it across re-fires of the same edit (an impatient second Save after the run
// already started) collapses them onto one run via the gateway idempotency cache
// instead of spawning a duplicate. Distinct edits (different entry or text) get
// distinct keys and run normally. Tradeoff: re-saving the same entry to identical
// text within the gateway idempotency window returns the prior run instead of
// regenerating — acceptable since an identical re-edit is a no-op change. FNV-1a
// collision risk (distinct text, same key) is negligible per user.
export function editResendRunId(entryId: string, text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `edit-${entryId}-${text.length}-${(hash >>> 0).toString(36)}`;
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
  opts?: { runId?: string },
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }
  if (state.chatSending) {
    return state.chatRunId;
  }

  const now = Date.now();
  appendUserChatMessage(state, msg, attachments, now);

  state.chatSending = true;
  setChatError(state, null);
  reconcileChatRunLifecycle(state, {
    clearRunStatus: true,
  });
  // A caller-supplied stable key lets a re-fired edit/resend reuse the same run
  // (idempotency cache) rather than dispatch a duplicate; otherwise a fresh id.
  const runId = opts?.runId ?? generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;

  try {
    const ack = await requestChatSend(state, { message: msg, attachments, runId });
    if (ack.status === "ok") {
      reconcileChatRunLifecycle(state, {
        outcome: "done",
        sessionStatus: "done",
        runId: ack.runId,
        sessionKey: state.sessionKey,
        clearLocalRun: true,
        clearChatStream: true,
        armLocalTerminalReconcile: true,
      });
    } else {
      state.chatRunId = ack.runId;
    }
    return ack.status === "ok" ? ack.runId : runId;
  } catch (err) {
    const error = formatConnectError(err);
    reconcileChatRunLifecycle(state, {
      outcome: "interrupted",
      sessionStatus: "failed",
      runId,
      sessionKey: state.sessionKey,
      clearLocalRun: true,
      clearChatStream: true,
    });
    setChatError(state, error);
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  } finally {
    state.chatSending = false;
  }
}

export function appendUserChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
  timestamp = Date.now(),
) {
  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: buildUserChatMessageContentBlocks(message, attachments),
      timestamp,
    },
  ];
}

async function sendChatMessageWithGeneratedRunId(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }
  setChatError(state, null);
  const runId = generateUUID();
  try {
    const ack = await requestChatSend(state, { message: msg, attachments, runId });
    return ack.runId;
  } catch (err) {
    setChatError(state, formatConnectError(err));
    return null;
  }
}

export async function sendDetachedChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  return sendChatMessageWithGeneratedRunId(state, message, attachments);
}

export async function sendSteerChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  return sendChatMessageWithGeneratedRunId(state, message, attachments);
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId
        ? {
            sessionKey: state.sessionKey,
            ...(() => {
              const agentId = resolveSelectedAgentId(state);
              return isGlobalSessionKey(state.sessionKey) && agentId ? { agentId } : {};
            })(),
            runId,
          }
        : {
            sessionKey: state.sessionKey,
            ...(() => {
              const agentId = resolveSelectedAgentId(state);
              return isGlobalSessionKey(state.sessionKey) && agentId ? { agentId } : {};
            })(),
          },
    );
    return true;
  } catch (err) {
    setChatError(state, formatConnectError(err));
    return false;
  }
}

/**
 * Update a backgrounded session's saved runtime from an event that doesn't
 * belong to the foreground session. Matched by runId (robust to session-key
 * canonicalization). We only need to clear the run flags on a terminal event so
 * the tab's running indicator stops; the full transcript is reloaded from
 * history when the user switches back, so streaming deltas are not replayed here.
 */
function peekBackgroundRunEvent(state: ChatState, payload: ChatEventPayload): void {
  if (typeof payload.runId !== "string") {
    return;
  }
  const runtimes = (state as { chatRuntimeBySession?: Record<string, SessionChatRuntime> })
    .chatRuntimeBySession;
  if (!runtimes) {
    return;
  }
  const terminal =
    payload.state === "final" || payload.state === "aborted" || payload.state === "error";
  if (!terminal) {
    return;
  }
  for (const runtime of Object.values(runtimes)) {
    if (runtime.chatRunId === payload.runId) {
      // The background run finished: clear its run flags so the tab's running
      // dot stops, but keep the saved transcript so switching back paints it
      // instantly (then history reload reconciles the final message). Growth is
      // bounded because closing a tab deletes its runtime (onCloseTab) and
      // switching back removes it from the store on restore.
      runtime.chatRunId = null;
      runtime.chatSending = false;
      runtime.chatStream = null;
      (state as { requestUpdate?: () => void }).requestUpdate?.();
      return;
    }
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  const hadActiveRunBeforeEvent = state.chatRunId !== null;
  const sessionMatches = chatEventSessionMatches(state, payload);
  const activeRunMatches =
    state.chatRunId !== null &&
    typeof payload.runId === "string" &&
    payload.runId === state.chatRunId;
  if (!sessionMatches && !activeRunMatches) {
    // Event for a backgrounded session (its runtime is saved, not foreground):
    // keep its running indicator honest so it clears when the run ends and a
    // switch-back reloads a completed transcript.
    peekBackgroundRunEvent(state, payload);
    return null;
  }
  if (!state.chatRunId && sessionMatches && typeof payload.runId === "string") {
    state.chatRunId = payload.runId;
    state.chatStreamStartedAt ??= Date.now();
  }

  // Terminal events for the active client run carry runId; missing-runId events are unowned.
  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizeFinalAssistantMessage(payload.message);
      if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
        state.chatMessages = [...state.chatMessages, finalMessage];
        return null;
      }
      return "final";
    }
    return null;
  }

  const terminalRunId = payload.runId ?? state.chatRunId;
  const reconcileTerminalRun = (
    outcome: "done" | "interrupted",
    sessionStatus: "done" | "failed" | "killed",
  ) =>
    reconcileChatRunLifecycle(state, {
      outcome,
      sessionStatus,
      runId: terminalRunId,
      sessionKey: state.sessionKey,
      sessionKeys: sessionMatches ? [state.sessionKey, payload.sessionKey] : [],
      clearLocalRun: true,
      clearChatStream: true,
      armLocalTerminalReconcile: hadActiveRunBeforeEvent && activeRunMatches,
    });

  if (payload.state === "delta") {
    // Guard: ignore late-arriving deltas after a terminal reconcile for this run.
    // The gateway may queue delta events that arrive after the ACK resolved
    // synchronously (ack.status === "ok") or after a final event already
    // reconciled the run to done. Processing these would re-activate
    // chatStream/chatThinkingStream after the done badge already flashed,
    // causing the "done → no dots → thinking badge" visual glitch.
    const terminalReconcile = state.lastLocalTerminalReconcile;
    const runAlreadyTerminal =
      terminalReconcile &&
      terminalReconcile.runId != null &&
      (terminalReconcile.runId === payload.runId || terminalReconcile.runId === state.chatRunId);
    if (!runAlreadyTerminal) {
      const next = resolveDeltaChatStreamText(state.chatStream, payload);
      if (
        typeof next === "string" &&
        !isSilentReplyStream(next) &&
        !isAssistantHeartbeatAckForDisplay(payload.message)
      ) {
        state.chatStream = next;
      }
      const nextThinking = resolveDeltaThinkingStreamText(state.chatThinkingStream, payload);
      if (typeof nextThinking === "string" && nextThinking) {
        state.chatThinkingStream = nextThinking;
        if (state.chatThinkingStreamStartedAt === null) {
          state.chatThinkingStreamStartedAt = Date.now();
        }
      }
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizeFinalAssistantMessage(payload.message);
    if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
      // Tag with local timestamp so preserveOptimisticTailMessages keeps it
      // if a racing history refresh arrives before the server has this message.
      if (!finalMessage.timestamp) {
        finalMessage.timestamp = Date.now();
      }
      state.chatMessages = appendTerminalAssistantMessage(state.chatMessages, finalMessage);
    } else {
      state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state);
    }
    reconcileTerminalRun("done", "done");
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !shouldHideAssistantChatMessage(normalizedMessage)) {
      state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
        replacementMessages: [normalizedMessage],
        includeCurrent: false,
      });
      state.chatMessages = appendTerminalAssistantMessage(state.chatMessages, normalizedMessage);
    } else {
      state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state);
    }
    reconcileTerminalRun("interrupted", "killed");
  } else if (payload.state === "error") {
    const payloadMessage = hadActiveRunBeforeEvent
      ? normalizeFinalAssistantMessage(payload.message)
      : null;
    const visiblePayloadMessage =
      payloadMessage && !shouldHideAssistantChatMessage(payloadMessage) ? payloadMessage : null;
    if (visiblePayloadMessage) {
      state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state, {
        replacementMessages: [visiblePayloadMessage],
      });
      state.chatMessages = appendTerminalAssistantMessage(
        state.chatMessages,
        visiblePayloadMessage,
      );
    } else {
      const errorMessage = hadActiveRunBeforeEvent ? buildErrorAssistantMessage(payload) : null;
      if (hadActiveRunBeforeEvent) {
        state.chatMessages = materializeVisibleAssistantStreamMessages(state.chatMessages, state);
      }
      if (errorMessage) {
        state.chatMessages = appendTerminalAssistantMessage(state.chatMessages, errorMessage);
      }
    }
    reconcileTerminalRun("interrupted", "failed");
    setChatError(state, payload.errorMessage ?? "chat error");
  }
  return payload.state;
}
