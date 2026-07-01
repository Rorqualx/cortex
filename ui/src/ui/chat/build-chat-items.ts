import type {
  ChatItem,
  MessageGroup,
  NormalizedMessage,
  SessionBranchPoint,
  ToolCard,
} from "../types/chat-types.ts";
import type { ChatQueueItem } from "../ui-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "./heartbeat-display.ts";
import { CHAT_HISTORY_RENDER_CHAR_BUDGET, CHAT_HISTORY_RENDER_LIMIT } from "./history-limits.ts";
import { extractTextCached } from "./message-extract.ts";
import { normalizeMessage, stripMessageDisplayMetadataText } from "./message-normalizer.ts";
import { normalizeRoleForGrouping } from "./role-normalizer.ts";
import { messageMatchesSearchQuery } from "./search-match.ts";
import { trimAccumulatedStreamPrefix } from "./stream-text.ts";
import { extractToolCardsCached, extractToolPreview } from "./tool-cards.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

export type BuildChatItemsProps = {
  sessionKey: string;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: Array<{ text: string; ts: number }>;
  stream: string | null;
  streamStartedAt: number | null;
  sendStartedAt?: number | null;
  thinkingStream?: string | null;
  thinkingStreamStartedAt?: number | null;
  sending?: boolean;
  runId?: string | null;
  /** Terminal run status from reconcileChatRunLifecycle — used to suppress
   * late-arriving thinking/stream items after the run already completed. */
  runStatus?: { phase: string; runId?: string | null } | null;
  queue?: ChatQueueItem[];
  showToolCalls: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
  /** Branch points from chat.branches API — injected as branch-point dividers. */
  branchPoints?: SessionBranchPoint[];
  /** Active branch path (root→leaf entry IDs) from chat.branches — anchors dividers. */
  branchActivePath?: string[];
  /** Override the default CHAT_HISTORY_RENDER_LIMIT for scroll-back expansion. */
  historyRenderLimit?: number;
};

function appendCanvasBlockToAssistantMessage(
  message: unknown,
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
  rawText: string | null,
) {
  const raw = message as Record<string, unknown>;
  const existingContent = Array.isArray(raw.content)
    ? [...raw.content]
    : typeof raw.content === "string"
      ? [{ type: "text", text: raw.content }]
      : typeof raw.text === "string"
        ? [{ type: "text", text: raw.text }]
        : [];
  const alreadyHasArtifact = existingContent.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const typed = block as {
      type?: unknown;
      preview?: { kind?: unknown; viewId?: unknown; url?: unknown };
    };
    return (
      typed.type === "canvas" &&
      typed.preview?.kind === "canvas" &&
      ((preview.viewId && typed.preview.viewId === preview.viewId) ||
        (preview.url && typed.preview.url === preview.url))
    );
  });
  if (alreadyHasArtifact) {
    return message;
  }
  return {
    ...raw,
    content: [
      ...existingContent,
      {
        type: "canvas",
        preview,
        ...(rawText ? { rawText } : {}),
      },
    ],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeNormalizeMessage(message: unknown): NormalizedMessage | null {
  if (!asRecord(message)) {
    return null;
  }
  try {
    return normalizeMessage(message);
  } catch {
    return null;
  }
}

function extractChatMessagePreview(toolMessage: unknown): {
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
  text: string | null;
  timestamp: number | null;
} | null {
  const normalized = safeNormalizeMessage(toolMessage);
  if (!normalized) {
    return null;
  }
  const cards = extractToolCardsCached(toolMessage, "preview");
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (card?.preview?.kind === "canvas") {
      return {
        preview: card.preview,
        text: card.outputText ?? null,
        timestamp: normalized.timestamp ?? null,
      };
    }
  }
  const text = extractTextCached(toolMessage) ?? undefined;
  const toolRecord = toolMessage as Record<string, unknown>;
  const toolName =
    typeof toolRecord.toolName === "string"
      ? toolRecord.toolName
      : typeof toolRecord.tool_name === "string"
        ? toolRecord.tool_name
        : undefined;
  const preview = extractToolPreview(text, toolName);
  if (preview?.kind !== "canvas") {
    return null;
  }
  return { preview, text: text ?? null, timestamp: normalized.timestamp ?? null };
}

function findNearestAssistantMessageIndex(
  items: ChatItem[],
  toolTimestamp: number | null,
): number | null {
  const assistantEntries = items
    .map((item, index) => {
      if (item.kind !== "message") {
        return null;
      }
      const message = item.message as Record<string, unknown>;
      const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
      if (role !== "assistant") {
        return null;
      }
      return {
        index,
        timestamp: safeNormalizeMessage(item.message)?.timestamp ?? null,
      };
    })
    .filter(Boolean) as Array<{ index: number; timestamp: number | null }>;
  if (assistantEntries.length === 0) {
    return null;
  }
  if (toolTimestamp == null) {
    return assistantEntries[assistantEntries.length - 1]?.index ?? null;
  }
  let previous: { index: number; timestamp: number } | null = null;
  let next: { index: number; timestamp: number } | null = null;
  for (const entry of assistantEntries) {
    if (entry.timestamp == null) {
      continue;
    }
    if (entry.timestamp <= toolTimestamp) {
      previous = { index: entry.index, timestamp: entry.timestamp };
      continue;
    }
    next = { index: entry.index, timestamp: entry.timestamp };
    break;
  }
  if (previous && next) {
    const previousDelta = toolTimestamp - previous.timestamp;
    const nextDelta = next.timestamp - toolTimestamp;
    return nextDelta < previousDelta ? next.index : previous.index;
  }
  if (previous) {
    return previous.index;
  }
  if (next) {
    return next.index;
  }
  return assistantEntries[assistantEntries.length - 1]?.index ?? null;
}

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const senderLabel =
      role.toLowerCase() === "user" || role.toLowerCase() === "assistant"
        ? (normalized.senderLabel ?? null)
        : null;
    const timestamp = normalized.timestamp || Date.now();
    const shouldSplitBySender = role.toLowerCase() === "user" || role.toLowerCase() === "assistant";

    if (
      !currentGroup ||
      currentGroup.role !== role ||
      (shouldSplitBySender && currentGroup.senderLabel !== senderLabel)
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        messages: [{ message: item.message, key: item.key, duplicateCount: item.duplicateCount }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({
        message: item.message,
        key: item.key,
        duplicateCount: item.duplicateCount,
      });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function collapseDuplicateDisplaySignature(message: unknown): string | null {
  const marker = asRecord(message)?.["__openclaw"];
  if (asRecord(marker)?.kind === "pending-send") {
    return null;
  }
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return null;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  if (!role || role === "tool") {
    return null;
  }
  if (normalized.content.length === 0) {
    return null;
  }
  const textParts: string[] = [];
  for (const block of normalized.content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      return null;
    }
    textParts.push(block.text);
  }
  const text = textParts.join("\n").trim().replace(/\s+/g, " ");
  if (!text) {
    return null;
  }
  const senderLabel =
    role === "user" || role === "assistant" ? (normalized.senderLabel ?? "").trim() : "";
  return `${role}:${senderLabel}:${text}`;
}

function collapseSequentialDuplicateMessages(items: ChatItem[]): ChatItem[] {
  const collapsed: ChatItem[] = [];
  let previousSignature: string | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      collapsed.push(item);
      previousSignature = null;
      continue;
    }
    const signature = collapseDuplicateDisplaySignature(item.message);
    const previous = collapsed[collapsed.length - 1];
    if (signature && previousSignature === signature && previous?.kind === "message") {
      previous.duplicateCount = (previous.duplicateCount ?? 1) + 1;
      continue;
    }
    collapsed.push(item);
    previousSignature = signature;
  }

  return collapsed;
}

/**
 * Remove stream segments whose text is already present in the last assistant
 * message. When a run completes, the final event appends the full assistant
 * message to chatMessages, but chatStreamSegments may still hold partial text
 * that was committed before a tool call interrupted the stream. Since segments
 * are `kind: "stream"` and messages are `kind: "message"`, the sequential
 * duplicate collapse logic won't catch them.
 */
function deduplicateStreamSegmentsAgainstFinal(items: ChatItem[]): ChatItem[] {
  // Collect the visible text of every assistant message in the current turn
  // (after the last user message). A multi-step turn commits each pre-tool text
  // burst as its own stream segment, and those bursts land in DIFFERENT persisted
  // messages — not just the final one — so matching a segment only against the
  // last assistant message (and only as a prefix) leaves earlier segments
  // rendering as near-duplicate blocks once the turn's messages persist.
  let lastUserIndex = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "message") {
      continue;
    }
    const normalized = safeNormalizeMessage(item.message);
    if (normalized && normalized.role.toLowerCase() === "user") {
      lastUserIndex = i;
      break;
    }
  }
  const assistantTexts: string[] = [];
  for (let i = lastUserIndex + 1; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "message") {
      continue;
    }
    const normalized = safeNormalizeMessage(item.message);
    if (!normalized || normalized.role.toLowerCase() !== "assistant") {
      continue;
    }
    const raw = extractTextCached(item.message);
    if (raw) {
      assistantTexts.push(sanitizeStreamText(raw));
    }
  }

  if (assistantTexts.length === 0) {
    return items;
  }

  // Drop a stream segment once its text is contained in a persisted message of
  // this turn (prefix, middle, or suffix — committed segments can be any slice).
  // Only drop when a message actually contains it, so a segment still renders
  // mid-run before its message exists; nothing is lost.
  return items.filter((item) => {
    if (item.kind !== "stream") {
      return true;
    }
    // The live in-progress segment has no persisted message of its own yet, so
    // never dedupe it: a short or repeated burst (e.g. "Done.") whose text
    // happens to appear inside an EARLIER persisted message would otherwise be
    // hidden mid-run, stalling the stream to a blank until its message persists.
    if (item.isStreaming) {
      return true;
    }
    const segText = sanitizeStreamText(item.text);
    if (segText.length === 0) {
      return true;
    }
    return !assistantTexts.some((text) => text.includes(segText));
  });
}

function hasRenderableNormalizedMessage(message: unknown): boolean {
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return false;
  }
  const role = normalizeRoleForGrouping(normalized.role);
  const hasVisibleSenderLabel = role === "assistant" && Boolean(normalized.senderLabel?.trim());
  return normalized.content.length > 0 || Boolean(normalized.replyTarget) || hasVisibleSenderLabel;
}

function sanitizeStreamText(text: string): string {
  const stripped = stripMessageDisplayMetadataText(text);
  return stripped.trim().length > 0 ? stripped : "";
}

function shouldRenderQueuedSendInThread(item: ChatQueueItem): boolean {
  if (typeof item.sendSubmittedAtMs !== "number" || item.sendState === "failed") {
    return false;
  }
  return (
    item.sendState === "waiting-model" ||
    item.sendState === "sending" ||
    item.sendState === "waiting-reconnect"
  );
}

function queuedSendThreadMessage(item: ChatQueueItem): Record<string, unknown> | null {
  const content = buildUserChatMessageContentBlocks(item.text, item.attachments);
  if (content.length === 0) {
    return null;
  }
  return {
    role: "user",
    content,
    timestamp: item.createdAt,
    __openclaw: {
      kind: "pending-send",
      id: item.id,
      state: item.sendState,
    },
  };
}

function rawMessageTimestamp(message: unknown): number | null {
  const timestamp = asRecord(message)?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

function chatItemTimestamp(item: ChatItem): number | null {
  switch (item.kind) {
    case "message":
      return item.key === "chat:history:notice"
        ? Number.NEGATIVE_INFINITY
        : rawMessageTimestamp(item.message);
    case "divider":
      return item.timestamp;
    case "branch-point":
      // Carries its anchor message's time so it sorts just above it. Without a
      // case here it returns null and the visible-time sort would dump every
      // branch divider at the bottom of the thread.
      return item.timestamp;
    case "stream":
      return item.startedAt;
    case "reading-indicator":
      return null;
  }
  return null;
}

function timestampAfterVisibleItems(items: ChatItem[], desiredTimestamp: number): number {
  const latestTimestamp = items.reduce<number | null>((latest, item) => {
    const timestamp = chatItemTimestamp(item);
    if (timestamp == null) {
      return latest;
    }
    return latest == null || timestamp > latest ? timestamp : latest;
  }, null);
  return latestTimestamp != null && desiredTimestamp <= latestTimestamp
    ? latestTimestamp + 1
    : desiredTimestamp;
}

function sortChatItemsByVisibleTime(items: ChatItem[]): ChatItem[] {
  return items
    .map((item, index) => ({ item, index, timestamp: chatItemTimestamp(item) }))
    .toSorted((a, b) => {
      if (a.timestamp == null && b.timestamp == null) {
        return a.index - b.index;
      }
      if (a.timestamp == null) {
        return 1;
      }
      if (b.timestamp == null) {
        return -1;
      }
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

type RawContentEstimateState = {
  visited: WeakSet<object>;
  nodes: number;
};

const RAW_CONTENT_ESTIMATE_MAX_DEPTH = 8;
const RAW_CONTENT_ESTIMATE_MAX_NODES = 400;

function addCapped(total: number, amount: number, limit: number): number {
  return Math.min(limit, total + Math.max(0, amount));
}

function estimateRawContentChars(
  value: unknown,
  limit: number,
  state: RawContentEstimateState,
  depth = 0,
): number {
  if (limit <= 0) {
    return 0;
  }
  if (typeof value === "string") {
    return Math.min(value.length, limit);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  if (depth >= RAW_CONTENT_ESTIMATE_MAX_DEPTH || state.nodes >= RAW_CONTENT_ESTIMATE_MAX_NODES) {
    return 0;
  }
  if (state.visited.has(value)) {
    return 0;
  }
  state.visited.add(value);
  state.nodes += 1;

  if (Array.isArray(value)) {
    let chars = 0;
    for (const item of value) {
      chars = addCapped(
        chars,
        estimateRawContentChars(item, limit - chars, state, depth + 1),
        limit,
      );
      if (chars >= limit) {
        break;
      }
    }
    return chars;
  }

  const record = value as Record<string, unknown>;
  let chars = 0;
  for (const key of ["text", "content", "args", "arguments", "input"] as const) {
    chars = addCapped(
      chars,
      estimateRawContentChars(record[key], limit - chars, state, depth + 1),
      limit,
    );
    if (chars >= limit) {
      break;
    }
  }
  return chars;
}

function estimateMessageRenderChars(message: unknown, limit: number): number {
  const record = asRecord(message);
  if (!record) {
    return 1;
  }
  const state: RawContentEstimateState = { visited: new WeakSet<object>(), nodes: 0 };
  let chars = 0;
  for (const key of ["content", "text", "args", "arguments", "input"] as const) {
    chars = addCapped(chars, estimateRawContentChars(record[key], limit - chars, state), limit);
    if (chars >= limit) {
      break;
    }
  }
  return Math.max(chars, 1);
}

function isHiddenToolMessage(message: unknown, showToolCalls: boolean): boolean {
  if (showToolCalls) {
    return false;
  }
  return safeNormalizeMessage(message)?.role.toLowerCase() === "toolresult";
}

function countVisibleHistoryMessages(messages: unknown[], showToolCalls: boolean): number {
  let count = 0;
  for (const message of messages) {
    if (!isHiddenToolMessage(message, showToolCalls)) {
      count += 1;
    }
  }
  return count;
}

function resolveHistoryStartIndex(
  messages: unknown[],
  showToolCalls: boolean,
  renderLimit?: number,
): number {
  const limit = renderLimit ?? CHAT_HISTORY_RENDER_LIMIT;
  let visibleCount = 0;
  let renderChars = 0;
  let startIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isHiddenToolMessage(message, showToolCalls)) {
      continue;
    }
    if (visibleCount >= limit) {
      break;
    }
    const remainingBudget = Math.max(1, CHAT_HISTORY_RENDER_CHAR_BUDGET - renderChars + 1);
    const messageChars = estimateMessageRenderChars(message, remainingBudget);
    if (visibleCount > 0 && renderChars + messageChars > CHAT_HISTORY_RENDER_CHAR_BUDGET) {
      break;
    }
    renderChars += messageChars;
    visibleCount += 1;
    startIndex = index;
  }
  return startIndex;
}

/**
 * Read the transcript entry id a history message carries. chat.history sets
 * __openclaw.id to the SessionEntry id — the same id space as branch points'
 * entryId / childIds / activePath, so dividers anchor by entry id rather than
 * the fragile embedded message id.
 */
function messageEntryId(message: unknown): string | null {
  const marker = asRecord(message)?.["__openclaw"] as Record<string, unknown> | undefined;
  const id = marker?.id;
  return typeof id === "string" ? id : null;
}

// Mirrors ROOT_PARENT_KEY in src/gateway/server-methods/chat-branch.ts: the
// entryId chat.branches reports for a fork at the transcript root (no parent).
const ROOT_BRANCH_ENTRY_ID = "__root__";

/**
 * Inject branch-point dividers anchored to the active branch path.
 *
 * A divider is keyed to the active-path index of its branch-from (parent) entry
 * and only emitted once that exact parent message has just been rendered — so
 * an edited-message branch renders inline at the edit (a first-message edit, the
 * root fork, lands above the first message). When the real divergence point is
 * scrolled out of the loaded window or filtered away, its parent is never
 * emitted, so the divider is dropped rather than hoisted onto an unrelated
 * message.
 */
function injectBranchPointDividers(
  items: ChatItem[],
  branchPoints: SessionBranchPoint[],
  activePath: string[],
): ChatItem[] {
  const activePathIndex = new Map(activePath.map((id, index) => [id, index]));
  // Group branch points by the active-path index of their branch-from entry.
  // A root fork has no parent entry, so it keys on -1 — the sentinel matched
  // before the first active-path message is emitted.
  const byParentIndex = new Map<number, SessionBranchPoint[]>();
  for (const bp of branchPoints) {
    if (bp.childCount <= 1 || bp.activeChildId === null || !activePathIndex.has(bp.activeChildId)) {
      continue;
    }
    const parentIndex = activePathIndex.has(bp.entryId)
      ? (activePathIndex.get(bp.entryId) as number)
      : bp.entryId === ROOT_BRANCH_ENTRY_ID
        ? -1
        : null;
    if (parentIndex === null) {
      continue;
    }
    const group = byParentIndex.get(parentIndex);
    if (group) {
      group.push(bp);
    } else {
      byParentIndex.set(parentIndex, [bp]);
    }
  }

  if (byParentIndex.size === 0) {
    return items;
  }

  // Active-path indices that actually render as a message. A branch-from entry
  // that is not in this set is either a non-rendering branch_marker (re-edit) or
  // a message scrolled out of the loaded window — the flush rule below tells
  // them apart.
  const renderedIndices = new Set<number>();
  for (const item of items) {
    if (item.kind !== "message") {
      continue;
    }
    const entryId = messageEntryId(item.message);
    const idx = entryId !== null ? activePathIndex.get(entryId) : undefined;
    if (idx !== undefined) {
      renderedIndices.add(idx);
    }
  }

  const result: ChatItem[] = [];
  // -1 matches a root fork's parent; updated to each active-path message as it
  // is emitted so a divider lands between its parent and the parent's next message.
  let prevInPathIndex = -1;
  let prevInPathTs: number | null = null;
  for (const item of items) {
    if (item.kind === "message") {
      const entryId = messageEntryId(item.message);
      const messageIndex = entryId !== null ? activePathIndex.get(entryId) : undefined;
      if (messageIndex !== undefined) {
        // Inherit the upcoming message's time so the visible-time sort keeps the
        // divider just above it (never floated to the bottom).
        const itemTs = chatItemTimestamp(item) ?? prevInPathTs ?? 0;
        // Flush every pending branch point that belongs just above this message:
        //  - a rendered-message (or root -1) parent flushes when it was the last
        //    message rendered (exact index match); but
        //  - a non-rendering branch_marker parent (re-editing an edited message
        //    parents the new turn onto the first edit's marker) flushes when a
        //    real message was rendered before it and it sits in the gap ahead of
        //    this message — so its divider still anchors here instead of being
        //    dropped. A branch point whose own message scrolled out has nothing
        //    rendered before it (prevInPathIndex < 0), so it stays dropped rather
        //    than hoisted onto an unrelated later message.
        const readyParents = [...byParentIndex.keys()]
          .filter((k) => {
            const parentIsRendered = k === -1 || renderedIndices.has(k);
            return parentIsRendered
              ? prevInPathIndex === k
              : prevInPathIndex >= 0 && k > prevInPathIndex && k < messageIndex;
          })
          .sort((a, b) => a - b);
        for (const k of readyParents) {
          for (const bp of byParentIndex.get(k)!) {
            result.push(branchPointDivider(bp, `branch:${bp.entryId}:${item.key}`, itemTs));
          }
          byParentIndex.delete(k);
        }
        prevInPathIndex = messageIndex;
        prevInPathTs = chatItemTimestamp(item) ?? prevInPathTs;
      }
    }
    result.push(item);
  }
  // Any branch points left here have a parent that never rendered (scrolled out
  // or filtered) — skip them rather than detach the divider from its context.
  return result;
}

function branchPointDivider(bp: SessionBranchPoint, key: string, timestamp: number): ChatItem {
  const activeChildIndex = bp.activeChildId ? bp.childIds.indexOf(bp.activeChildId) : -1;
  return {
    kind: "branch-point",
    key,
    entryId: bp.entryId,
    childCount: bp.childCount,
    // Counter reflects the active child's slot; clamp to 0 if it isn't listed.
    activeChildIndex: activeChildIndex >= 0 ? activeChildIndex : 0,
    label: bp.label,
    timestamp,
  };
}

export function buildChatItems(props: BuildChatItemsProps): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const history = (Array.isArray(props.messages) ? props.messages : []).filter(
    (message) => !isAssistantHeartbeatAckForDisplay(message),
  );
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const liftedCanvasSources = tools
    .map((tool) => extractChatMessagePreview(tool))
    .filter((entry) => Boolean(entry)) as Array<{
    preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
    text: string | null;
    timestamp: number | null;
  }>;
  const historyStart = resolveHistoryStartIndex(
    history,
    props.showToolCalls,
    props.historyRenderLimit,
  );
  const hiddenHistoryCount = countVisibleHistoryMessages(
    history.slice(0, historyStart),
    props.showToolCalls,
  );
  const visibleHistoryCount = countVisibleHistoryMessages(
    history.slice(historyStart),
    props.showToolCalls,
  );
  if (hiddenHistoryCount > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${visibleHistoryCount} messages (${hiddenHistoryCount} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = safeNormalizeMessage(msg);
    if (!normalized) {
      continue;
    }
    const raw = asRecord(msg) ?? {};
    const marker = raw["__openclaw"] as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: "Compacted history",
        description:
          "The compacted transcript is preserved as a checkpoint. Open session checkpoints to branch or restore from that compacted view.",
        action: {
          kind: "session-checkpoints",
          label: "Open checkpoints",
        },
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (!props.showToolCalls && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    const searchQuery = props.searchQuery ?? "";
    if (props.searchOpen && searchQuery.trim() && !messageMatchesSearchQuery(msg, searchQuery)) {
      continue;
    }
    if (!hasRenderableNormalizedMessage(msg) && normalized.role.toLowerCase() !== "assistant") {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  const queuedSends = Array.isArray(props.queue) ? props.queue : [];
  for (const queued of queuedSends) {
    if (!shouldRenderQueuedSendInThread(queued)) {
      continue;
    }
    const message = queuedSendThreadMessage(queued);
    if (!message) {
      continue;
    }
    const searchQuery = props.searchQuery ?? "";
    if (
      props.searchOpen &&
      searchQuery.trim() &&
      !messageMatchesSearchQuery(message, searchQuery)
    ) {
      continue;
    }
    items.push({
      kind: "message",
      key: `pending-send:${queued.id}`,
      message,
    });
    // Show a reading indicator for each pending send in sending state.
    // This ensures follow-ups always get processing feedback even when
    // the stream from the previous run is still active.
    if (queued.sendState === "sending") {
      items.push({
        kind: "reading-indicator",
        key: `pending-indicator:${queued.id}`,
      });
    }
  }
  for (const liftedCanvasSource of liftedCanvasSources) {
    const assistantIndex = findNearestAssistantMessageIndex(items, liftedCanvasSource.timestamp);
    if (assistantIndex == null) {
      continue;
    }
    const item = items[assistantIndex];
    if (!item || item.kind !== "message") {
      continue;
    }
    items[assistantIndex] = {
      ...item,
      message: appendCanvasBlockToAssistantMessage(
        item.message as Record<string, unknown>,
        liftedCanvasSource.preview,
        liftedCanvasSource.text,
      ),
    };
  }
  items = items.filter(
    (item) => item.kind !== "message" || hasRenderableNormalizedMessage(item.message),
  );
  const segments = props.streamSegments ?? [];
  const maxLen = Math.max(segments.length, tools.length);
  let previousAccumulatedStreamText: string | null = null;
  for (let i = 0; i < maxLen; i++) {
    if (i < segments.length) {
      const text = sanitizeStreamText(segments[i].text);
      const visibleText = trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText);
      if (text.length > 0) {
        previousAccumulatedStreamText = text;
      }
      if (visibleText.length > 0) {
        items.push({
          kind: "stream",
          key: `stream-seg:${props.sessionKey}:${i}`,
          text: visibleText,
          startedAt: segments[i].ts,
          isStreaming: false,
        });
      }
    }
    if (i < tools.length && props.showToolCalls) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      });
    }
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    const text = sanitizeStreamText(props.stream);
    const visibleText = trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText);
    // Live stream answers the latest turn: never let a stale startedAt sort it
    // above already-visible persisted items.
    const startedAt = timestampAfterVisibleItems(items, props.streamStartedAt ?? Date.now());
    if (visibleText.length > 0) {
      if (!stripHeartbeatTokenForDisplay(visibleText).shouldSkip) {
        items.push({
          kind: "stream",
          key,
          text: visibleText,
          startedAt,
          isStreaming: true,
        });
      }
    } else if (props.stream.trim().length === 0) {
      items.push({ kind: "reading-indicator", key });
    }
  } else if (props.runId || props.sending) {
    // Active run but no stream text — show thinking indicator.
    // Uses runId (active run exists) as primary trigger so the indicator
    // survives tool execution, history refreshes, and stream resets.
    const key = `thinking:${props.sessionKey}:${props.runId ?? "sending"}`;
    items.push({ kind: "reading-indicator", key });
  }

  // Suppress thinking stream when the run has already been terminal-reconciled.
  // Without this guard, a late-arriving thinking delta (processed before the
  // delta guard in controllers/chat.ts took effect) would render a thinking
  // badge after the done badge already displayed.
  const hasTerminalRunStatus =
    props.runStatus?.phase === "done" || props.runStatus?.phase === "interrupted";
  if (props.thinkingStream != null && !hasTerminalRunStatus) {
    const key = `thinking:${props.sessionKey}:${props.thinkingStreamStartedAt ?? "live"}`;
    items.push({
      kind: "thinking",
      key,
      text: props.thinkingStream,
      startedAt: props.thinkingStreamStartedAt ?? Date.now(),
      isStreaming: true,
    });
  }

  // Deduplicate stream segments against the final assistant message.
  // When a run completes, the final event appends the assistant message to
  // chatMessages, but streamSegments (committed before tool calls) may still
  // hold the same text. Since segments are kind:"stream" and messages are
  // kind:"message", collapseSequentialDuplicateMessages won't catch them.
  items = deduplicateStreamSegmentsAgainstFinal(items);

  // Inject branch-point dividers anchored to the active branch path.
  if (props.branchPoints && props.branchPoints.length > 0) {
    items = injectBranchPointDividers(items, props.branchPoints, props.branchActivePath ?? []);
  }

  return groupMessages(collapseSequentialDuplicateMessages(sortChatItemsByVisibleTime(items)));
}

function messageKey(message: unknown, index: number): string {
  const m = asRecord(message) ?? {};
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    const role = typeof m.role === "string" ? m.role : "unknown";
    // Key on the call id alone: it is assigned at creation and is identical
    // for the live (pre-persist) and persisted copies of the same tool message.
    // Folding in id/messageId/timestamp/index made the key flip across the
    // live→persisted boundary and as history grew mid-run, so `repeat` remounted
    // the card every render tick and replayed its entrance animation in a loop.
    return `tool:${role}:${toolCallId}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
