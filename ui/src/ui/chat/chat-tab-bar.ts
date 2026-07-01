// Chat tab bar — multi-tab session header for the chat window.
// Supports drag-and-drop reordering and localStorage persistence.
import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { AppViewState } from "../app-view-state.ts";
import { icons } from "../icons.ts";
import { resolveSessionDisplayName } from "../session-display.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../session-key.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";

// ── Persistence helpers ──────────────────────────────────────────────
const TAB_STATE_KEY = "openclaw.control.tabs.v1";

interface PersistedTabState {
  openTabs: string[];
  activeTab: string;
}

function loadPersistedTabs(): PersistedTabState | null {
  try {
    const storage = getSafeLocalStorage();
    const raw = storage?.getItem(TAB_STATE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedTabState;
    if (Array.isArray(parsed.openTabs) && typeof parsed.activeTab === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function savePersistedTabs(openTabs: string[], activeTab: string): void {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    const state: PersistedTabState = { openTabs, activeTab };
    storage.setItem(TAB_STATE_KEY, JSON.stringify(state));
  } catch {
    // best-effort
  }
}

export function restorePersistedTabs(): { openTabs: string[]; activeTab: string } | null {
  return loadPersistedTabs();
}

// ── Drag state (module-level, shared across renders) ─────────────────
let draggedSessionKey: string | null = null;

// ── Tab status tracking (persists across renders) ────────────────────
const tabActiveRuns = new Set<string>();
const tabCompletedUnviewed = new Map<string, "done" | "interrupted">();
/** How long the done dot stays visible on the active tab after a run finishes.
 *  Set to Infinity to keep it until user interaction. */
const ACTIVE_DONE_DISPLAY_MS = Infinity;
/** Maps sessionKey → timestamp when the done dot first appeared on the active tab. */
const tabActiveDoneShownAt = new Map<string, number>();

/** Clear the done dot on the active tab — call from any user interaction handler. */
export function dismissActiveTabDoneDot(): void {
  tabActiveDoneShownAt.clear();
}

/** Tracks the last chatRunId to detect when the user sends a new message. */
let lastChatRunId: string | null = null;

// ── Label resolution ─────────────────────────────────────────────────
/** Max tab label length for goal-based titles. */
const GOAL_TAB_MAX_LEN = 28;

function resolveChatTabLabel(
  _state: AppViewState,
  sessionKey: string,
  sessions: SessionsListResult | null | undefined,
): string {
  const row = sessions?.sessions.find((s) => s.key === sessionKey);

  // Priority 1: Goal objective ("Phase 2: Message-level embedding index")
  if (row?.goal?.objective) {
    const obj = row.goal.objective.trim();
    return obj.length > GOAL_TAB_MAX_LEN ? obj.slice(0, GOAL_TAB_MAX_LEN) + "…" : obj;
  }

  // Priority 2: Server-derived title (from firstUserMessage, displayName, subject)
  if (row?.derivedTitle && row.derivedTitle !== sessionKey) {
    const dt = row.derivedTitle;
    return dt.length > GOAL_TAB_MAX_LEN ? dt.slice(0, GOAL_TAB_MAX_LEN) + "…" : dt;
  }

  // Priority 3: Existing display name resolution
  const display = resolveSessionDisplayName(sessionKey, row);
  if (display === sessionKey) {
    const parsed = parseAgentSessionKey(sessionKey);
    if (parsed?.rest) {
      return parsed.rest.length > 20 ? parsed.rest.slice(0, 20) + "…" : parsed.rest;
    }
    return sessionKey.length > 16 ? sessionKey.slice(0, 16) + "…" : sessionKey;
  }
  return display.length > GOAL_TAB_MAX_LEN ? display.slice(0, GOAL_TAB_MAX_LEN) + "…" : display;
}

function resolveAgentIdForTab(state: AppViewState, sessionKey: string): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? state.agentsList?.defaultId ?? "main");
}

function resolveAgentLabel(state: AppViewState, agentId: string): string {
  const agent = (state.agentsList?.agents ?? []).find((a) => normalizeAgentId(a.id) === agentId);
  const name = agent?.identity?.name ?? agent?.name;
  return name && name !== agentId ? name : agentId;
}

/** Tab list with the current session guaranteed present (it may not yet be persisted). */
function getEffectiveTabs(state: AppViewState): string[] {
  const tabs = state.chatOpenSessionTabs;
  const currentKey = state.sessionKey;
  return tabs.includes(currentKey) ? tabs : [currentKey, ...tabs.filter((k) => k !== currentKey)];
}

function isNewSessionDisabled(state: AppViewState): boolean {
  // New sessions can start during an active run — switching preserves the
  // running session's runtime so it continues in the background. Only the brief
  // send-RPC window (chatSending) blocks, since its ack writes to the foreground.
  return !state.connected || !state.client || state.chatSending;
}

// ── Tab status indicator ─────────────────────────────────────────────

function resolveTabRunState(
  state: AppViewState,
  sessionKey: string,
  row: GatewaySessionRow | undefined,
  isActiveTab: boolean,
): "active" | "done" | "interrupted" | "idle" {
  const rowActive = row ? isSessionRunActive(row) : false;
  const isCurrent = sessionKey === state.sessionKey;
  const hasLocalRun = isCurrent && Boolean(state.chatRunId);
  // A backgrounded session keeps its live run in the per-session runtime store,
  // so show its running dot immediately without waiting for the sessions poll.
  const backgroundRun = !isCurrent && Boolean(state.chatRuntimeBySession?.[sessionKey]?.chatRunId);
  const isRunning = rowActive || hasLocalRun || backgroundRun;

  // User sent a new message — clear the done dot
  if (state.chatRunId && state.chatRunId !== lastChatRunId) {
    dismissActiveTabDoneDot();
  }
  lastChatRunId = state.chatRunId;

  // User is actively typing/sending — clear the done dot
  if (state.chatSending) {
    dismissActiveTabDoneDot();
  }

  if (isRunning) {
    // Clear any active-done timestamp (agent came back to life)
    tabActiveDoneShownAt.delete(sessionKey);
    tabActiveRuns.add(sessionKey);
    return "active";
  }

  // ── Active tab (foreground): brief done dot with timestamp expiry ─
  if (isActiveTab) {
    // Active → done transition on the foreground tab
    if (tabActiveRuns.has(sessionKey)) {
      tabActiveRuns.delete(sessionKey);
      tabActiveDoneShownAt.set(sessionKey, Date.now());
      return "done";
    }
    // Done dot still within display window
    const shownAt = tabActiveDoneShownAt.get(sessionKey);
    if (shownAt != null) {
      if (Date.now() - shownAt < ACTIVE_DONE_DISPLAY_MS) {
        return "done";
      }
      tabActiveDoneShownAt.delete(sessionKey);
    }
    return "idle";
  }

  // ── Background tab: persistent dot until user clicks ──────────────

  // Active → done transition (local tracking)
  if (tabActiveRuns.has(sessionKey)) {
    tabActiveRuns.delete(sessionKey);
    const outcome: "done" | "interrupted" = row?.status === "killed" ? "interrupted" : "done";
    tabCompletedUnviewed.set(sessionKey, outcome);
    return outcome;
  }

  // Still tracked as completed-unviewed from a previous render
  if (tabCompletedUnviewed.has(sessionKey)) {
    return tabCompletedUnviewed.get(sessionKey)!;
  }

  // Catch terminal states we never saw go active (fast agents that
  // finish before the first sessions-list poll includes them)
  if (row?.status === "done" || row?.status === "failed" || row?.status === "timeout") {
    tabCompletedUnviewed.set(sessionKey, "done");
    return "done";
  }
  if (row?.status === "killed") {
    tabCompletedUnviewed.set(sessionKey, "interrupted");
    return "interrupted";
  }

  return "idle";
}

function renderTabStatusDot(
  runState: "active" | "done" | "interrupted" | "idle",
): typeof nothing | TemplateResult {
  if (runState === "idle") {
    return nothing;
  }

  if (runState === "active") {
    return html`
      <span class="chat-tab-bar__status-dot chat-tab-bar__status-dot--active" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14">
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-dasharray="3 3"
            stroke-linecap="round"
          />
        </svg>
      </span>
    `;
  }

  const cls =
    runState === "interrupted"
      ? "chat-tab-bar__status-dot--interrupted"
      : "chat-tab-bar__status-dot--done";
  return html`<span class="chat-tab-bar__status-dot ${cls}" aria-hidden="true"></span>`;
}

// ── Main render ──────────────────────────────────────────────────────
export function renderChatTabBar(
  state: AppViewState,
  options: {
    onSwitchSession: (nextKey: string) => void;
    onNewSession: () => void;
    onCloseTab: (sessionKey: string) => void;
    onReorderTabs?: (reordered: string[]) => void;
  },
): TemplateResult | typeof nothing {
  const { onSwitchSession, onNewSession, onCloseTab, onReorderTabs } = options;
  const currentKey = state.sessionKey;
  const sessions = state.sessionsResult;
  const effectiveTabs = getEffectiveTabs(state);

  // Single tab collapses into the breadcrumb header (renderCollapsedChatTab);
  // only render the dedicated row once there are multiple tabs to switch between.
  if (effectiveTabs.length <= 1) {
    return nothing;
  }

  const newDisabled = isNewSessionDisabled(state);

  // Auto-scroll the active tab into view after render.
  const scheduleActiveTabScroll = () => {
    requestAnimationFrame(() => {
      const bar = document.querySelector(".chat-tab-bar__tabs");
      if (!bar) {
        return;
      }
      const active = bar.querySelector(".chat-tab-bar__tab--active");
      if (active) {
        active.scrollIntoView({ inline: "nearest", behavior: "smooth", block: "nearest" });
      }
    });
  };

  // ── Drag handlers ────────────────────────────────────────────────
  function handleDragStart(e: DragEvent, key: string) {
    draggedSessionKey = key;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", key);
    }
    const target = e.currentTarget as HTMLElement;
    // Slight delay so the drag image captures the element before styling
    requestAnimationFrame(() => {
      target.classList.add("chat-tab-bar__tab--dragging");
    });
  }

  function handleDragEnd(e: DragEvent) {
    draggedSessionKey = null;
    const target = e.currentTarget as HTMLElement;
    target.classList.remove("chat-tab-bar__tab--dragging");
    // Clean up all drag-over classes in the tab bar
    const bar = target.closest(".chat-tab-bar__tabs");
    if (bar) {
      bar
        .querySelectorAll(".chat-tab-bar__tab--drag-over-left, .chat-tab-bar__tab--drag-over-right")
        .forEach((el) => {
          el.classList.remove(
            "chat-tab-bar__tab--drag-over-left",
            "chat-tab-bar__tab--drag-over-right",
          );
        });
    }
  }

  function handleDragOver(e: DragEvent, _key: string) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    if (!draggedSessionKey) {
      return;
    }

    const target = e.currentTarget as HTMLElement;
    // Determine if cursor is on left or right half
    const rect = target.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const isLeft = e.clientX < midX;

    // Clear all indicators in the bar first
    const bar = target.closest(".chat-tab-bar__tabs");
    if (bar) {
      bar
        .querySelectorAll(".chat-tab-bar__tab--drag-over-left, .chat-tab-bar__tab--drag-over-right")
        .forEach((el) => {
          el.classList.remove(
            "chat-tab-bar__tab--drag-over-left",
            "chat-tab-bar__tab--drag-over-right",
          );
        });
    }

    if (isLeft) {
      target.classList.add("chat-tab-bar__tab--drag-over-left");
    } else {
      target.classList.add("chat-tab-bar__tab--drag-over-right");
    }
  }

  function handleDragLeave(e: DragEvent) {
    const target = e.currentTarget as HTMLElement;
    target.classList.remove(
      "chat-tab-bar__tab--drag-over-left",
      "chat-tab-bar__tab--drag-over-right",
    );
  }

  function handleDrop(e: DragEvent, targetKey: string) {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.classList.remove(
      "chat-tab-bar__tab--drag-over-left",
      "chat-tab-bar__tab--drag-over-right",
    );

    if (!draggedSessionKey || draggedSessionKey === targetKey) {
      return;
    }

    const rect = target.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const insertBefore = e.clientX < midX;

    // Reorder the tabs array
    const currentTabs = [...effectiveTabs];
    const dragIdx = currentTabs.indexOf(draggedSessionKey);
    if (dragIdx === -1) {
      return;
    }
    currentTabs.splice(dragIdx, 1);

    let targetIdx = currentTabs.indexOf(targetKey);
    if (targetIdx === -1) {
      return;
    }

    if (!insertBefore) {
      targetIdx += 1;
    }
    currentTabs.splice(targetIdx, 0, draggedSessionKey);

    if (onReorderTabs) {
      onReorderTabs(currentTabs);
    } else {
      // Fallback: directly mutate state
      state.chatOpenSessionTabs = currentTabs;
      savePersistedTabs(currentTabs, state.sessionKey);
    }

    draggedSessionKey = null;
  }

  // Clear active-tab done dot on any click in the tab bar
  function handleBarClick() {
    tabActiveDoneShownAt.clear();
  }

  return html`
    <div
      class="chat-tab-bar"
      role="tablist"
      aria-label=${t("chat.selectors.session")}
      @click=${handleBarClick}
    >
      <div
        class="chat-tab-bar__tabs"
        @wheel=${(e: WheelEvent) => {
          // Horizontal scroll via trackpad or shift+vertical wheel.
          // Normalize deltaX (trackpad) and deltaY (mouse wheel) into
          // horizontal scroll so tabs push left/right when the cursor
          // hovers over the tab bar.
          const container = e.currentTarget as HTMLElement;
          if (container.scrollWidth <= container.clientWidth) {
            return;
          } // nothing to scroll
          const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (dx === 0) {
            return;
          }
          // Only prevent default when we actually scroll (avoids eating
          // vertical page scroll when tabs fit without overflow).
          if (container.scrollWidth > container.clientWidth) {
            e.preventDefault();
            container.scrollBy({ left: dx, behavior: "auto" });
          }
        }}
      >
        ${effectiveTabs.map((key) => {
          const active = key === currentKey;
          const label = resolveChatTabLabel(state, key, sessions);
          const agentId = resolveAgentIdForTab(state, key);
          const agentLabel = resolveAgentLabel(state, agentId);
          const row = sessions?.sessions.find((s) => s.key === key);
          const runState = resolveTabRunState(state, key, row, active);
          return html`
            <button
              class="chat-tab-bar__tab ${active ? "chat-tab-bar__tab--active" : ""}"
              role="tab"
              aria-selected=${active ? "true" : "false"}
              title=${`OpenClaw › ${agentLabel} › Chat (${key})`}
              type="button"
              draggable="true"
              @click=${() => {
                if (!active) {
                  onSwitchSession(key);
                  scheduleActiveTabScroll();
                }
              }}
              @dragstart=${(e: DragEvent) => handleDragStart(e, key)}
              @dragend=${handleDragEnd}
              @dragover=${(e: DragEvent) => handleDragOver(e, key)}
              @dragleave=${handleDragLeave}
              @drop=${(e: DragEvent) => handleDrop(e, key)}
            >
              ${renderTabStatusDot(runState)}
              <span class="chat-tab-bar__tab-label">${label}</span>
              ${effectiveTabs.length > 1
                ? html`
                    <span
                      class="chat-tab-bar__tab-close"
                      role="button"
                      title="Close tab"
                      aria-label="Close tab"
                      @click=${(e: MouseEvent) => {
                        e.stopPropagation();
                        onCloseTab(key);
                      }}
                    >
                      ${icons.x}
                    </span>
                  `
                : nothing}
            </button>
          `;
        })}
      </div>
      <button
        class="chat-tab-bar__new"
        type="button"
        title=${t("chat.runControls.newSession")}
        aria-label=${t("chat.runControls.newSession")}
        ?disabled=${newDisabled}
        @click=${onNewSession}
      >
        ${icons.plus}
      </button>
    </div>
  `;
}

// ── Collapsed (single-tab) breadcrumb variant ────────────────────────
// When only one session is open the dedicated tab row is hidden; the
// active session and the new-session button render inline after the
// "Chat" breadcrumb segment instead. Returns nothing once a second tab
// opens — renderChatTabBar takes over the row at that point.
export function renderCollapsedChatTab(
  state: AppViewState,
  options: { onNewSession: () => void },
): TemplateResult | typeof nothing {
  const effectiveTabs = getEffectiveTabs(state);
  if (effectiveTabs.length !== 1) {
    return nothing;
  }
  const key = effectiveTabs[0];
  if (!key) {
    return nothing;
  }

  const sessions = state.sessionsResult;
  const label = resolveChatTabLabel(state, key, sessions);
  const row = sessions?.sessions.find((s) => s.key === key);
  const runState = resolveTabRunState(state, key, row, true);
  const newDisabled = isNewSessionDisabled(state);

  return html`
    <span class="chat-tab-crumb">
      <span class="dashboard-header__breadcrumb-sep">›</span>
      <span class="chat-tab-crumb__chip" title=${label}>
        ${renderTabStatusDot(runState)}
        <span class="chat-tab-crumb__label">${label}</span>
      </span>
      <button
        class="chat-tab-bar__new chat-tab-crumb__new"
        type="button"
        title=${t("chat.runControls.newSession")}
        aria-label=${t("chat.runControls.newSession")}
        ?disabled=${newDisabled}
        @click=${options.onNewSession}
      >
        ${icons.plus}
      </button>
    </span>
  `;
}
