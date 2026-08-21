// Control UI module implements app render behavior.
import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import {
  createChatSessionsLoadOverrides,
  refreshChat,
  refreshChatAvatar,
  resolveAgentIdForSession,
  scopedAgentListParamsForSession,
} from "./app-chat.ts";
import { syncUrlWithSessionKey } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import { agentAvatarUrl } from "./avatar/agent-avatar.ts";
import { savePersistedTabs } from "./chat/chat-tab-bar.ts";
import { persistChatComposerState, restoreChatComposerState } from "./chat/composer-persistence.ts";
import { reconcileChatRunLifecycle } from "./chat/run-lifecycle.ts";
import {
  renderChatSessionSelect as renderChatSessionSelectBase,
  renderChatModelSelect,
  resetChatSessionPickerState,
  resolveSessionOptionGroups,
  resolveSidebarNewSessionAgentId,
  resolveSidebarNewSessionModel,
  switchChatModel,
} from "./chat/session-controls.ts";
import {
  applyChatRuntime,
  captureChatRuntime,
  shouldRetainChatRuntime,
  type ChatRuntimeHost,
} from "./chat/session-runtime.ts";
import { refreshSlashCommands } from "./chat/slash-commands.ts";
import { resolveControlUiAuthToken } from "./control-ui-auth.ts";
import { loadBranches, loadChatHistory } from "./controllers/chat.ts";
import type { ChatState } from "./controllers/chat.ts";
import { loadSessions, syncSelectedSessionMessageSubscription } from "./controllers/sessions.ts";
import { icons } from "./icons.ts";
import { iconForTab, isSettingsTab, pathForTab, titleForTab, type Tab } from "./navigation.ts";
import { isCronSessionKey, parseSessionKey, resolveSessionDisplayName } from "./session-display.ts";
import {
  isSessionKeyTiedToAgent,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "./session-key.ts";
import { normalizeChatAutoScrollMode, type ChatAutoScrollMode } from "./storage.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "./string-coerce.ts";
import type { ThemeMode } from "./theme.ts";
import type { SessionsListResult } from "./types.ts";
import type { ChatQueueItem } from "./ui-types.ts";

export { isCronSessionKey, parseSessionKey, resolveSessionDisplayName, resolveSessionOptionGroups };

type SessionDefaultsSnapshot = {
  mainSessionKey?: string;
  mainKey?: string;
};

type SessionSwitchHost = AppViewState & {
  chatStreamStartedAt: number | null;
  chatHistoryHasMore: boolean;
  chatHistoryNextOffset: number | null;
  chatSideResultTerminalRuns: Set<string>;
  resetChatInputHistoryNavigation(): void;
  resetToolStream(): void;
  resetChatScroll(): void;
};

type ChatRefreshHost = AppViewState & {
  chatManualRefreshInFlight: boolean;
  chatNewMessagesBelow: boolean;
  resetToolStream(): void;
  scrollToBottom(opts?: { smooth?: boolean }): void;
  updateComplete?: Promise<unknown>;
};

export async function handleChatManualRefresh(state: ChatRefreshHost): Promise<void> {
  state.chatManualRefreshInFlight = true;
  state.chatNewMessagesBelow = false;
  await state.updateComplete;
  state.resetToolStream();
  try {
    await refreshChat(state as unknown as Parameters<typeof refreshChat>[0], {
      awaitHistory: true,
      scheduleScroll: false,
    });
    state.scrollToBottom({ smooth: true });
  } finally {
    requestAnimationFrame(() => {
      state.chatManualRefreshInFlight = false;
      state.chatNewMessagesBelow = false;
    });
  }
}

export type ChannelChatNavCandidate = {
  key: string;
  row: SessionsListResult["sessions"][number];
  channelId: string;
  updatedAt: number;
};

// Internal origin surface for Control-UI/dashboard chats. Such sessions render
// under the "Chat" tab and must never be listed as channel conversations, even
// if their session key carries a real channel segment.
const WEBCHAT_SURFACE = "webchat";

/**
 * One candidate per inbound channel conversation (telegram/discord/…), newest
 * first. `knownChannelIds` gates which sessions count as channel chats so
 * non-channel rows (main/global/subagent/cron/spawned) are excluded. Dedupes by
 * session key keeping the freshest snapshot (the two caches we read can each hold
 * the same key); labels are resolved by the caller for only the rows that survive
 * its cap.
 */
export function collectChannelChatNavCandidates(
  sessions: readonly SessionsListResult["sessions"][number][],
  knownChannelIds: ReadonlySet<string>,
): ChannelChatNavCandidate[] {
  const byKey = new Map<string, ChannelChatNavCandidate>();
  for (const row of sessions) {
    if (row.kind !== "direct" && row.kind !== "group") {
      continue;
    }
    if (row.spawnedBy || isSubagentSessionKey(row.key) || isCronSessionKey(row.key)) {
      continue;
    }
    // Webchat/dashboard chats belong to the "Chat" tab, never under "Channels" —
    // even when their session key carries a channel segment (a drifted or
    // mis-keyed session, e.g. agent:main:telegram:...). The origin surface is
    // authoritative for internal surfaces, so classify by it rather than letting
    // the key's channel segment win.
    if (row.origin?.surface?.toLowerCase() === WEBCHAT_SURFACE) {
      continue;
    }
    // For real channel chats the session key is the authoritative channel
    // source; row.channel/origin are fallbacks for keys that aren't
    // channel-shaped. Take the first candidate the gateway actually knows, so a
    // stale row.channel can't drop a real chat.
    const fromKey = parseAgentSessionKey(row.key)?.rest.split(":")[0]?.toLowerCase();
    const channelId = [
      fromKey,
      row.channel?.toLowerCase(),
      row.origin?.surface?.toLowerCase(),
    ].find((candidate) => candidate && knownChannelIds.has(candidate));
    if (!channelId) {
      continue;
    }
    const lowerKey = row.key.toLowerCase();
    const updatedAt = row.updatedAt ?? 0;
    const existing = byKey.get(lowerKey);
    if (!existing || updatedAt > existing.updatedAt) {
      byKey.set(lowerKey, { key: row.key, row, channelId, updatedAt });
    }
  }
  return [...byKey.values()].toSorted((a, b) => b.updatedAt - a.updatedAt);
}

export function resolveAssistantAttachmentAuthToken(
  state: Pick<AppViewState, "hello" | "settings" | "password">,
) {
  return resolveControlUiAuthToken(state);
}

export function resolveDashboardHeaderContext(
  state: Pick<AppViewState, "agentsList" | "sessionKey">,
): { agentLabel: string; agentId: string; agentAvatarUrl: string } {
  const agentId = resolveAgentIdFromSessionKey(state.sessionKey);
  const agent = state.agentsList?.agents.find(
    (entry) => normalizeLowercaseStringOrEmpty(entry.id) === agentId,
  );
  const agentLabel =
    normalizeOptionalString(agent?.identity?.name) ??
    normalizeOptionalString(agent?.name) ??
    agentId;
  // Same canonical avatar (assigned image, else generated invader) used by the
  // office/workboard grid, so the brand mirrors the agent shown in the breadcrumb.
  return {
    agentLabel,
    agentId,
    agentAvatarUrl: agentAvatarUrl(agentId, {
      avatar: agent?.identity?.avatar,
      avatarUrl: agent?.identity?.avatarUrl,
    }),
  };
}

function resolveSidebarChatSessionKey(state: AppViewState): string {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const mainSessionKey = normalizeOptionalString(snapshot?.sessionDefaults?.mainSessionKey);
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = normalizeOptionalString(snapshot?.sessionDefaults?.mainKey);
  if (mainKey) {
    return mainKey;
  }
  return "main";
}

function saveChatQueueForSession(state: AppViewState, sessionKey: string) {
  const queueBySession = (state.chatQueueBySession ??= {});
  if (state.chatQueue.length > 0) {
    queueBySession[sessionKey] = [...state.chatQueue];
    state.chatQueueBySession = { ...queueBySession };
    return;
  }
  if (Object.hasOwn(queueBySession, sessionKey)) {
    delete queueBySession[sessionKey];
    state.chatQueueBySession = { ...queueBySession };
  }
}

function restoreChatQueueForSession(state: AppViewState, sessionKey: string): ChatQueueItem[] {
  return [...(state.chatQueueBySession?.[sessionKey] ?? [])];
}

/** Save the outgoing session's live runtime so a background run survives the
 *  switch; drop idle/finished runtimes (cheaply rebuilt from history on return). */
function saveChatRuntimeForSession(state: AppViewState, sessionKey: string) {
  const store = (state.chatRuntimeBySession ??= {});
  const runtime = captureChatRuntime(state as unknown as ChatRuntimeHost);
  if (shouldRetainChatRuntime(runtime)) {
    store[sessionKey] = runtime;
  } else {
    delete store[sessionKey];
  }
}

function resetChatStateForSessionSwitch(
  state: AppViewState,
  sessionKey: string,
): { restored: boolean } {
  const host = state as unknown as SessionSwitchHost;
  const previousSessionKey = state.sessionKey;
  persistChatComposerState(state, previousSessionKey);
  saveChatQueueForSession(state, previousSessionKey);
  saveChatRuntimeForSession(state, previousSessionKey);
  state.sessionKey = sessionKey;
  if (previousSessionKey !== sessionKey) {
    resetChatSessionPickerState(state);
  }
  // Composer, activity, error and avatar are not part of the per-session runtime.
  state.chatMessage = "";
  state.chatAttachments = [];
  state.activityEvents = [];
  state.activityExpandedIds = new Set();
  state.activityAtBottom = true;
  state.activityCursor = null;
  state.activityHasMore = false;
  state.activityError = null;
  state.activitySubscribed = false;
  state.lastError = null;
  state.chatError = null;
  state.chatHistoryLastAppliedAt = undefined;
  // Avatar is per-agent, not per-session: clearing it here made it blink away and
  // refetch on every same-agent conversation switch. It's now cleared/refetched
  // only when the switch crosses agents (see switchChatSessionInternal).
  state.realtimeTalkTranscript = null;
  state.resetRealtimeTalkConversation?.();
  state.chatQueue = restoreChatQueueForSession(state, sessionKey);
  restoreChatComposerState(state);
  host.resetChatInputHistoryNavigation();

  // Run/transcript state: restore a backgrounded session's saved runtime (so its
  // live run and transcript reappear), else clear to a fresh session.
  const runtimeStore = (state.chatRuntimeBySession ??= {});
  const savedRuntime = runtimeStore[sessionKey];
  let restored = false;
  if (savedRuntime) {
    delete runtimeStore[sessionKey];
    applyChatRuntime(state as unknown as ChatRuntimeHost, savedRuntime);
    // Compaction/fallback banners are foreground-global (not part of the saved
    // runtime); clear the outgoing session's so they don't leak onto this one.
    reconcileChatRunLifecycle(
      state as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
      {},
    );
    restored = true;
  } else {
    (state as unknown as { currentSessionId?: string | null }).currentSessionId = null;
    state.chatMessages = [];
    // Pagination belongs to the previous transcript: a scroll-to-top before the
    // new session's history applies must not fetch with the old session's offset.
    host.chatHistoryHasMore = false;
    host.chatHistoryNextOffset = null;
    state.chatToolMessages = [];
    state.chatStreamSegments = [];
    state.chatThinkingLevel = null;
    state.chatStream = null;
    state.chatSideResult = null;
    state.chatLiveUsage = null;
    // Branch state is per-session too; clearing it here also fixes it leaking
    // (stale dividers) into a freshly switched session.
    state.branchPoints = [];
    state.branchActivePath = [];
    host.chatStreamStartedAt = null;
    reconcileChatRunLifecycle(state as unknown as Parameters<typeof reconcileChatRunLifecycle>[0], {
      clearLocalRun: true,
      clearChatStream: true,
      clearToolStream: true,
      clearSideResultTerminalRuns: true,
      clearRunStatus: true,
    });
  }
  host.resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
  return { restored };
}

export function renderTab(state: AppViewState, tab: Tab, opts?: { collapsed?: boolean }) {
  const href = pathForTab(tab, state.basePath);
  const isActive = tab === "config" ? isSettingsTab(state.tab) : state.tab === tab;
  const collapsed = opts?.collapsed ?? state.settings.navCollapsed;
  return html`
    <a
      href=${href}
      class="nav-item ${isActive ? "nav-item--active" : ""}"
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        if (tab === "chat") {
          if (!state.sessionKey) {
            const mainSessionKey = resolveSidebarChatSessionKey(state);
            resetChatStateForSessionSwitch(state, mainSessionKey);
          }
          if (state.tab !== "chat") {
            void state.loadAssistantIdentity();
          }
        }
        state.setTab(tab);
      }}
      title=${titleForTab(tab)}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconForTab(tab)]}</span>
      ${!collapsed ? html`<span class="nav-item__text">${titleForTab(tab)}</span>` : nothing}
    </a>
  `;
}

function renderCronFilterIcon(hiddenCount: number) {
  return html`
    <span style="position: relative; display: inline-flex; align-items: center;">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 16 14"></polyline>
      </svg>
      ${hiddenCount > 0
        ? html`<span
            style="
              position: absolute;
              top: -5px;
              right: -6px;
              background: var(--color-accent, #6366f1);
              color: #fff;
              border-radius: var(--radius-full);
              font-size: 9px;
              line-height: 1;
              padding: 1px 3px;
              pointer-events: none;
            "
            >${hiddenCount}</span
          >`
        : ""}
    </span>
  `;
}

export function renderChatSessionSelect(state: AppViewState) {
  return renderChatSessionSelectBase(state, switchChatSession, { surface: "desktop" });
}

function chatAutoScrollLabel(mode: ChatAutoScrollMode) {
  switch (mode) {
    case "always":
      return t("chat.autoScrollAlways");
    case "off":
      return t("chat.autoScrollOff");
    case "near-bottom":
      return t("chat.autoScrollNearBottom");
  }
  return t("chat.autoScrollNearBottom");
}

function nextChatAutoScrollMode(mode: ChatAutoScrollMode): ChatAutoScrollMode {
  switch (mode) {
    case "near-bottom":
      return "always";
    case "always":
      return "off";
    case "off":
      return "near-bottom";
  }
  return "near-bottom";
}

function renderChatAutoScrollToggle(state: AppViewState, options: { labelled?: boolean } = {}) {
  const mode = normalizeChatAutoScrollMode(state.settings.chatAutoScroll);
  const label = `${t("chat.autoScrollMode")}: ${chatAutoScrollLabel(mode)}`;
  const active = mode !== "off";
  return html`
    <button
      class="btn btn--sm btn--icon ${options.labelled ? "chat-settings-action" : ""} ${active
        ? "active"
        : ""}"
      data-chat-auto-scroll-toggle="true"
      data-chat-auto-scroll-mode=${mode}
      data-tooltip=${label}
      aria-label=${label}
      aria-pressed=${active}
      title=${label}
      @click=${() => {
        state.applySettings({
          ...state.settings,
          chatAutoScroll: nextChatAutoScrollMode(mode),
        });
      }}
    >
      ${icons.scrollText}
      ${options.labelled
        ? html`<span class="chat-settings-action__text">${t("chat.autoScrollMode")}</span>`
        : ""}
    </button>
  `;
}

export function renderChatControls(state: AppViewState) {
  const hideCron = state.sessionsHideCron ?? true;
  const hiddenCronCount = hideCron ? countHiddenCronSessions(state, state.sessionsResult) : 0;
  const disableThinkingToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const thinkingLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.thinkingToggle");
  const toolCallsLabel = disableThinkingToggle
    ? t("chat.onboardingDisabled")
    : t("chat.toolCallsToggle");
  const refreshDisabled =
    !state.connected ||
    state.chatManualRefreshInFlight ||
    state.chatLoading ||
    state.chatSending ||
    state.chatStream !== null ||
    Boolean(state.chatRunId);
  const cronLabel = hideCron
    ? hiddenCronCount > 0
      ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
      : t("chat.showCronSessions")
    : t("chat.hideCronSessions");
  const toolCallsIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `;
  const autoScrollMode = normalizeChatAutoScrollMode(state.settings.chatAutoScroll);
  const autoScrollActive = autoScrollMode !== "off";
  const autoScrollLabel = `${t("chat.autoScrollMode")}: ${chatAutoScrollLabel(autoScrollMode)}`;

  // Surface each chat-settings action as its own composer icon button (like the
  // attach/mic buttons) instead of hiding them behind a "Chat settings" dropdown.
  // The mobile gear (renderChatMobileToggle) still owns the collapsed list.
  return html`
    <div class="chat-composer-model-control">${renderChatModelSelect(state)}</div>
    <div class="chat-composer-quick-actions">
      <button
        class="agent-chat__input-btn"
        ?disabled=${refreshDisabled}
        @click=${() => {
          if (!refreshDisabled) {
            void handleChatManualRefresh(state as ChatRefreshHost);
          }
        }}
        title=${t("common.refresh")}
        aria-label=${t("common.refresh")}
      >
        ${icons.refresh}
        <span class="agent-chat__control-label">${t("common.refresh")}</span>
      </button>
      <button
        class="agent-chat__input-btn ${autoScrollActive ? "agent-chat__input-btn--active" : ""}"
        data-chat-auto-scroll-toggle="true"
        data-chat-auto-scroll-mode=${autoScrollMode}
        @click=${() => {
          state.applySettings({
            ...state.settings,
            chatAutoScroll: nextChatAutoScrollMode(autoScrollMode),
          });
        }}
        aria-pressed=${autoScrollActive}
        title=${autoScrollLabel}
        aria-label=${autoScrollLabel}
      >
        ${icons.scrollText}
        <span class="agent-chat__control-label">${t("chat.autoScrollMode")}</span>
      </button>
      <button
        class="agent-chat__input-btn ${showThinking ? "agent-chat__input-btn--active" : ""}"
        ?disabled=${disableThinkingToggle}
        @click=${() => {
          if (disableThinkingToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatShowThinking: !state.settings.chatShowThinking,
          });
        }}
        aria-pressed=${showThinking}
        title=${thinkingLabel}
        aria-label=${thinkingLabel}
      >
        ${icons.brain}
        <span class="agent-chat__control-label">${t("cron.form.thinking")}</span>
      </button>
      <button
        class="agent-chat__input-btn ${showToolCalls ? "agent-chat__input-btn--active" : ""}"
        ?disabled=${disableThinkingToggle}
        @click=${() => {
          if (disableThinkingToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatShowToolCalls: !state.settings.chatShowToolCalls,
          });
        }}
        aria-pressed=${showToolCalls}
        title=${toolCallsLabel}
        aria-label=${toolCallsLabel}
      >
        ${toolCallsIcon}
        <span class="agent-chat__control-label">${t("agents.tabs.tools")}</span>
      </button>
      <button
        class="agent-chat__input-btn ${hideCron ? "agent-chat__input-btn--active" : ""}"
        @click=${() => {
          state.sessionsHideCron = !hideCron;
        }}
        aria-pressed=${hideCron}
        title=${cronLabel}
        aria-label=${cronLabel}
      >
        ${renderCronFilterIcon(hiddenCronCount)}
        <span class="agent-chat__control-label">${t("cron.jobList.history")}</span>
      </button>
      <button
        class="agent-chat__input-btn"
        @click=${() => {
          state.vaultComposerModalOpen = true;
        }}
        title=${t("vault.addCredential")}
        aria-label=${t("vault.addCredential")}
      >
        ${icons.key}
        <span class="agent-chat__control-label">${t("vault.addCredential")}</span>
      </button>
    </div>
  `;
}

/**
 * Mobile-only gear toggle + dropdown for chat controls.
 * Rendered in the topbar so it doesn't consume content-header space.
 * Hidden on desktop via CSS.
 */
export function renderChatMobileToggle(state: AppViewState) {
  const controlsDropdownId = "chat-mobile-controls-dropdown";
  const mobileControlsOpen = state.chatMobileControlsOpen;
  const disableThinkingToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const hideCron = state.sessionsHideCron ?? true;
  const hiddenCronCount = hideCron ? countHiddenCronSessions(state, state.sessionsResult) : 0;
  const toolCallsIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `;

  return html`
    <div class="chat-mobile-controls-wrapper">
      <button
        class="btn btn--sm btn--icon chat-controls-mobile-toggle"
        @click=${(e: Event) => {
          e.stopPropagation();
          state.setChatMobileControlsOpen(!mobileControlsOpen, {
            trigger: e.currentTarget as HTMLElement,
          });
        }}
        title=${t("chat.settings")}
        aria-label=${t("chat.settings")}
        aria-expanded=${mobileControlsOpen}
        aria-controls=${controlsDropdownId}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="3"></circle>
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          ></path>
        </svg>
      </button>
      <div
        id=${controlsDropdownId}
        class="chat-controls-dropdown ${mobileControlsOpen ? "open" : ""}"
        @click=${(e: Event) => {
          e.stopPropagation();
        }}
      >
        <div class="chat-controls">
          ${renderChatSessionSelectBase(state, switchChatSession, { surface: "mobile" })}
          <div class="chat-controls__thinking">
            ${renderChatAutoScrollToggle(state)}
            <button
              class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
              ?disabled=${disableThinkingToggle}
              @click=${() => {
                if (!disableThinkingToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatShowThinking: !state.settings.chatShowThinking,
                  });
                }
              }}
              aria-pressed=${showThinking}
              title=${t("chat.thinkingToggle")}
            >
              ${icons.brain}
            </button>
            <button
              class="btn btn--sm btn--icon ${showToolCalls ? "active" : ""}"
              ?disabled=${disableThinkingToggle}
              @click=${() => {
                if (!disableThinkingToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatShowToolCalls: !state.settings.chatShowToolCalls,
                  });
                }
              }}
              aria-pressed=${showToolCalls}
              title=${t("chat.toolCallsToggle")}
            >
              ${toolCallsIcon}
            </button>
            <button
              class="btn btn--sm btn--icon ${hideCron ? "active" : ""}"
              @click=${() => {
                state.sessionsHideCron = !hideCron;
              }}
              aria-pressed=${hideCron}
              title=${hideCron
                ? hiddenCronCount > 0
                  ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
                  : t("chat.showCronSessions")
                : t("chat.hideCronSessions")}
            >
              ${renderCronFilterIcon(hiddenCronCount)}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function switchChatSessionInternal(
  state: AppViewState,
  nextSessionKey: string,
  opts?: { awaitInitialLoad?: boolean; isNewDraft?: boolean },
): Promise<void> | undefined {
  const previousSessionKey = state.sessionKey;
  // Never switch away while a chat.send RPC is in flight: its ack continuation
  // writes the run binding to the *foreground* state, so switching in that window
  // would route the outgoing session's run onto the newly-foreground one. Gate on
  // chatSendsInFlight, NOT chatSending — chatSending stays true for the whole run
  // (thinking indicator), and an active run's runtime is snapshotted per session
  // on switch-away, so switching mid-run is safe.
  if ((state.chatSendsInFlight ?? 0) > 0 && previousSessionKey !== nextSessionKey) {
    return undefined;
  }
  const nextSessionRow =
    state.sessionsResult?.sessions.find((row) => row.key === nextSessionKey) ??
    state.chatSessionPickerResult?.sessions.find((row) => row.key === nextSessionKey);
  const nextSessionLabel = resolveSessionDisplayName(nextSessionKey, nextSessionRow);
  resetChatStateForSessionSwitch(state, nextSessionKey);
  if (previousSessionKey !== nextSessionKey) {
    state.announceSessionSwitch?.(nextSessionKey, nextSessionLabel);
    // Track session in the open tabs list
    if (!state.chatOpenSessionTabs.includes(nextSessionKey)) {
      state.chatOpenSessionTabs = [...state.chatOpenSessionTabs, nextSessionKey];
    }
    savePersistedTabs(state.chatOpenSessionTabs, nextSessionKey);
  }
  // Assistant identity, header avatar, and slash commands are per-agent, not
  // per-session. Re-fetching them on every same-agent conversation switch cleared
  // and reloaded identical data, blinking the avatar and every message row's
  // name/avatar on each click. Only refresh when the switch crosses agents.
  const previousAgentId = resolveAgentIdForSession(state, previousSessionKey);
  const nextAgentId = resolveAgentIdForSession(state, nextSessionKey);
  if (previousAgentId !== nextAgentId) {
    void state.loadAssistantIdentity();
    void refreshChatAvatar(state);
    void refreshSlashCommands({
      client: state.client,
      agentId: parseAgentSessionKey(nextSessionKey)?.agentId,
    });
  }
  syncUrlWithSessionKey(
    state as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
    nextSessionKey,
    true,
  );
  const subscriptionSync = syncSelectedSessionMessageSubscription(
    state as unknown as AppViewState & { chatSessionMessageSubscriptionKey?: string | null },
  );
  // A brand-new draft has no server transcript to fetch; skipping the load keeps
  // it out of the grey loading skeleton and lets the composer render at once.
  const historyLoad = opts?.isNewDraft
    ? Promise.resolve(undefined)
    : loadChatHistory(state as unknown as ChatState);
  // Branch state is per-session and was cleared/replaced on switch, so refetch it
  // for the target (skipped for drafts, which have no branches yet).
  if (!opts?.isNewDraft) {
    void loadBranches(state as unknown as ChatState);
  }
  const sessionsRefresh = refreshSessionOptions(state);
  if (opts?.awaitInitialLoad) {
    void sessionsRefresh;
    return Promise.allSettled([subscriptionSync, historyLoad]).then(() => undefined);
  }
  void subscriptionSync;
  void historyLoad;
  void sessionsRefresh;
  return undefined;
}

export function switchChatSession(state: AppViewState, nextSessionKey: string): void {
  void switchChatSessionInternal(state, nextSessionKey);
}

export function switchChatSessionAndWait(
  state: AppViewState,
  nextSessionKey: string,
): Promise<void> {
  return (
    switchChatSessionInternal(state, nextSessionKey, { awaitInitialLoad: true }) ??
    Promise.resolve()
  );
}

export function dismissChatError(state: AppViewState) {
  state.lastError = null;
  state.lastErrorCode = null;
  state.chatError = null;
  if (state.realtimeTalkStatus === "error") {
    const talkHost = state as unknown as {
      realtimeTalkSession?: { stop(): void } | null;
    };
    talkHost.realtimeTalkSession?.stop();
    talkHost.realtimeTalkSession = null;
    state.realtimeTalkActive = false;
    state.realtimeTalkStatus = "idle";
    state.realtimeTalkDetail = null;
    state.realtimeTalkTranscript = null;
    state.resetRealtimeTalkConversation?.();
  }
}

export async function createChatSession(state: AppViewState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  // An active run is fine — it keeps running in the background via the runtime
  // store. But a send RPC in flight must finish first: its ack continuation
  // writes to the foreground session, so switching now would misroute it. Queued
  // follow-ups only flush for the foreground session, so they'd be stranded too.
  // Gate on chatSendsInFlight, not chatSending (which stays true the whole run).
  const sendRpcInFlight = (state.chatSendsInFlight ?? 0) > 0;
  if (sendRpcInFlight || state.chatQueue.length > 0) {
    state.lastError = sendRpcInFlight
      ? "Wait for the current message to send before starting a new session."
      : "Send or clear the queued messages before starting a new session.";
    state.chatError = state.lastError;
    return false;
  }

  state.lastError = null;
  state.chatError = null;
  // Draft-only switch: no sessions.create here. The gateway materializes the
  // session when the first message is sent, so an opened-but-unused new chat
  // never registers in session history.
  // The sidebar combo decides the target agent: an explicit sidebar pick wins,
  // else the new session stays on the active session's agent.
  // An in-progress run in the current session is preserved by the per-session
  // runtime store on switch, so a new session can start while it keeps running.
  const agentId = resolveSidebarNewSessionAgentId(state);
  const nextSessionKey = `agent:${agentId}:dashboard:${crypto.randomUUID()}`;
  const preservedDraft = state.chatMessage;
  const preservedAttachments = state.chatAttachments;
  // isNewDraft: the key has no server transcript yet, so skip the history load
  // (which would otherwise show the grey loading skeleton while the gateway is
  // busy with another session's run) and render the composer immediately.
  void switchChatSessionInternal(state, nextSessionKey, { isNewDraft: true });
  state.chatMessage = preservedDraft;
  state.chatAttachments = preservedAttachments;
  const newSessionModel = resolveSidebarNewSessionModel(state);
  if (newSessionModel) {
    // Start the session on the sidebar agent+model combo. sessions.patch
    // materializes the entry so the first run already serves the chosen model.
    void switchChatModel(state, newSessionModel);
  }
  return true;
}

async function refreshSessionOptions(state: AppViewState) {
  await loadSessions(state as unknown as Parameters<typeof loadSessions>[0], {
    ...createChatSessionsLoadOverrides(state),
    ...scopedAgentListParamsForSession(state, state.sessionKey),
  });
}

/** Count cron sessions hidden by the active agent-scoped chat filter. */
function countHiddenCronSessions(state: AppViewState, sessions: SessionsListResult | null): number {
  if (!sessions?.sessions) {
    return 0;
  }
  const activeAgentId = normalizeAgentId(
    parseAgentSessionKey(state.sessionKey)?.agentId ?? state.agentsList?.defaultId ?? "main",
  );
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");

  return sessions.sessions.filter(
    (s) =>
      isCronSessionKey(s.key) &&
      s.key !== state.sessionKey &&
      isSessionKeyTiedToAgent(s.key, activeAgentId, defaultAgentId),
  ).length;
}

type ThemeModeOption = { id: ThemeMode; labelKey: string; short: string };
const THEME_MODE_OPTIONS: ThemeModeOption[] = [
  { id: "system", labelKey: "common.system", short: "SYS" },
  { id: "light", labelKey: "common.light", short: "LIGHT" },
  { id: "dark", labelKey: "common.dark", short: "DARK" },
];

export function renderTopbarThemeModeToggle(state: AppViewState) {
  const modeIcon = (mode: ThemeMode) => {
    if (mode === "system") {
      return icons.monitor;
    }
    if (mode === "light") {
      return icons.sun;
    }
    return icons.moon;
  };

  const applyMode = (mode: ThemeMode, e: Event) => {
    if (mode === state.themeMode) {
      return;
    }
    state.setThemeMode(mode, { element: e.currentTarget as HTMLElement });
  };

  return html`
    <div class="topbar-theme-mode" role="group" aria-label=${t("common.colorMode")}>
      ${THEME_MODE_OPTIONS.map((opt) => {
        const label = t(opt.labelKey);
        const tooltip = t("common.colorModeOption", { mode: label });
        return html`
          <button
            type="button"
            class="topbar-theme-mode__btn ${opt.id === state.themeMode
              ? "topbar-theme-mode__btn--active"
              : ""}"
            title=${tooltip}
            aria-label=${tooltip}
            data-tooltip=${tooltip}
            aria-pressed=${opt.id === state.themeMode}
            @click=${(e: Event) => applyMode(opt.id, e)}
          >
            ${modeIcon(opt.id)}
          </button>
        `;
      })}
    </div>
  `;
}

export function renderSidebarConnectionStatus(state: AppViewState) {
  const label = state.connected ? t("common.online") : t("common.offline");
  const toneClass = state.connected
    ? "sidebar-connection-status--online"
    : "sidebar-connection-status--offline";

  return html`
    <span
      class="sidebar-version__status ${toneClass}"
      role="img"
      aria-live="polite"
      aria-label=${t("chat.gatewayStatus", { status: label })}
      title=${t("chat.gatewayStatus", { status: label })}
    ></span>
  `;
}
