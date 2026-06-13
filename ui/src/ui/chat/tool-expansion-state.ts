// Control UI chat module implements tool expansion state behavior.
import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import { isToolResultMessage, normalizeRoleForGrouping } from "./role-normalizer.ts";
import { getOrCreateSessionCacheValue } from "./session-cache.ts";
import { extractToolCardsCached } from "./tool-cards.ts";

const expandedToolCardsBySession = new Map<string, Map<string, boolean>>();
const initializedToolCardsBySession = new Map<string, Set<string>>();
const lastAutoExpandPrefBySession = new Map<string, boolean>();
// Live-run follow state: ids we expanded automatically (and may auto-collapse
// later) vs ids the user toggled by hand (never auto-managed again).
const autoExpandedToolCardsBySession = new Map<string, Set<string>>();
const userToggledToolCardsBySession = new Map<string, Set<string>>();

export function getExpandedToolCards(sessionKey: string): Map<string, boolean> {
  return getOrCreateSessionCacheValue(expandedToolCardsBySession, sessionKey, () => new Map());
}

function getInitializedToolCards(sessionKey: string): Set<string> {
  return getOrCreateSessionCacheValue(initializedToolCardsBySession, sessionKey, () => new Set());
}

function getAutoExpandedToolCards(sessionKey: string): Set<string> {
  return getOrCreateSessionCacheValue(autoExpandedToolCardsBySession, sessionKey, () => new Set());
}

function getUserToggledToolCards(sessionKey: string): Set<string> {
  return getOrCreateSessionCacheValue(userToggledToolCardsBySession, sessionKey, () => new Set());
}

/** Record a manual expand/collapse so live-run auto follow stops managing this id. */
export function markToolDisclosureUserToggled(sessionKey: string, disclosureId: string) {
  getUserToggledToolCards(sessionKey).add(disclosureId);
  getAutoExpandedToolCards(sessionKey).delete(disclosureId);
}

export function resetToolExpansionStateForTest() {
  expandedToolCardsBySession.clear();
  initializedToolCardsBySession.clear();
  lastAutoExpandPrefBySession.clear();
  autoExpandedToolCardsBySession.clear();
  userToggledToolCardsBySession.clear();
}

function isToolMessageEntry(message: unknown): boolean {
  const messageRecord = message as Record<string, unknown>;
  const role = typeof messageRecord.role === "string" ? messageRecord.role : "unknown";
  return (
    isToolResultMessage(message) ||
    normalizeRoleForGrouping(role) === "tool" ||
    role.toLowerCase() === "toolresult" ||
    role.toLowerCase() === "tool_result" ||
    typeof messageRecord.toolCallId === "string" ||
    typeof messageRecord.tool_call_id === "string"
  );
}

// The active tail is the newest tool work in a live run: the latest message's
// disclosures plus the activity group wrapping them. These follow the run —
// expanded while current, collapsed once the run moves on or finishes.
function collectActiveTailIds(items: Array<ChatItem | MessageGroup>): Set<string> {
  const tailIds = new Set<string>();
  let lastGroup: MessageGroup | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && item.kind === "group") {
      lastGroup = item;
      break;
    }
  }
  if (!lastGroup) {
    return tailIds;
  }
  const lastEntry = lastGroup.messages[lastGroup.messages.length - 1];
  if (!lastEntry) {
    return tailIds;
  }
  if (normalizeRoleForGrouping(lastGroup.role) === "tool" && lastGroup.messages.length > 1) {
    tailIds.add(`activity:${lastGroup.key}`);
  }
  const cards = extractToolCardsCached(lastEntry.message, lastEntry.key);
  for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
    tailIds.add(`${lastEntry.key}:toolcard:${cardIndex}`);
  }
  if (isToolMessageEntry(lastEntry.message)) {
    tailIds.add(`toolmsg:${lastEntry.key}`);
  }
  return tailIds;
}

export function syncToolCardExpansionState(
  sessionKey: string,
  items: Array<ChatItem | MessageGroup>,
  autoExpandToolCalls: boolean,
  runActive = false,
) {
  const expanded = getExpandedToolCards(sessionKey);
  const initialized = getInitializedToolCards(sessionKey);
  const autoExpanded = getAutoExpandedToolCards(sessionKey);
  const userToggled = getUserToggledToolCards(sessionKey);
  const previousAutoExpand = lastAutoExpandPrefBySession.get(sessionKey) ?? false;
  const currentToolCardIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== "group") {
      continue;
    }
    for (const entry of item.messages) {
      const cards = extractToolCardsCached(entry.message, entry.key);
      for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
        const disclosureId = `${entry.key}:toolcard:${cardIndex}`;
        currentToolCardIds.add(disclosureId);
        if (initialized.has(disclosureId)) {
          continue;
        }
        expanded.set(disclosureId, autoExpandToolCalls);
        initialized.add(disclosureId);
      }
      if (!isToolMessageEntry(entry.message)) {
        continue;
      }
      const disclosureId = `toolmsg:${entry.key}`;
      currentToolCardIds.add(disclosureId);
      if (initialized.has(disclosureId)) {
        continue;
      }
      expanded.set(disclosureId, autoExpandToolCalls);
      initialized.add(disclosureId);
    }
  }
  if (autoExpandToolCalls && !previousAutoExpand) {
    for (const toolCardId of currentToolCardIds) {
      expanded.set(toolCardId, true);
    }
  }
  const activeTailIds = runActive ? collectActiveTailIds(items) : new Set<string>();
  for (const disclosureId of activeTailIds) {
    if (userToggled.has(disclosureId)) {
      continue;
    }
    if (!autoExpanded.has(disclosureId)) {
      expanded.set(disclosureId, true);
      autoExpanded.add(disclosureId);
    }
    initialized.add(disclosureId);
  }
  for (const disclosureId of [...autoExpanded]) {
    if (activeTailIds.has(disclosureId)) {
      continue;
    }
    autoExpanded.delete(disclosureId);
    if (userToggled.has(disclosureId)) {
      continue;
    }
    if (disclosureId.startsWith("activity:")) {
      // Activity groups have a contextual default (open on error); deleting
      // restores it instead of pinning the group closed.
      expanded.delete(disclosureId);
    } else {
      expanded.set(disclosureId, false);
    }
  }
  lastAutoExpandPrefBySession.set(sessionKey, autoExpandToolCalls);
}
