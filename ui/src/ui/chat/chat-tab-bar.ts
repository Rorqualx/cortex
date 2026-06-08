// Chat tab bar — multi-tab session header for the chat window.
// Supports drag-and-drop reordering and localStorage persistence.
import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { type AppViewState } from "../app-view-state.ts";
import { icons } from "../icons.ts";
import { resolveSessionDisplayName } from "../session-display.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../session-key.ts";
import type { SessionsListResult } from "../types.ts";

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
    if (!raw) return null;
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
    if (!storage) return;
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

// ── Label resolution ─────────────────────────────────────────────────
/** Max tab label length for goal-based titles. */
const GOAL_TAB_MAX_LEN = 28;

function resolveChatTabLabel(
  state: AppViewState,
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

// ── Main render ──────────────────────────────────────────────────────
export function renderChatTabBar(
  state: AppViewState,
  options: {
    onSwitchSession: (nextKey: string) => void;
    onNewSession: () => void;
    onCloseTab: (sessionKey: string) => void;
    onReorderTabs?: (reordered: string[]) => void;
  },
): TemplateResult {
  const { onSwitchSession, onNewSession, onCloseTab, onReorderTabs } = options;
  const currentKey = state.sessionKey;
  const tabs = state.chatOpenSessionTabs;
  const sessions = state.sessionsResult;

  // Ensure current session is always in the tab list
  const effectiveTabs = tabs.includes(currentKey)
    ? tabs
    : [currentKey, ...tabs.filter((k) => k !== currentKey)];

  const newDisabled =
    !state.connected ||
    state.chatSending ||
    Boolean(state.chatRunId) ||
    state.chatLoading ||
    !state.client;

  // Auto-scroll the active tab into view after render.
  const scheduleActiveTabScroll = () => {
    requestAnimationFrame(() => {
      const bar = document.querySelector(".chat-tab-bar__tabs");
      if (!bar) return;
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
    if (!draggedSessionKey) return;

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

    if (!draggedSessionKey || draggedSessionKey === targetKey) return;

    const rect = target.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const insertBefore = e.clientX < midX;

    // Reorder the tabs array
    const currentTabs = [...effectiveTabs];
    const dragIdx = currentTabs.indexOf(draggedSessionKey);
    if (dragIdx === -1) return;
    currentTabs.splice(dragIdx, 1);

    let targetIdx = currentTabs.indexOf(targetKey);
    if (targetIdx === -1) return;

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

  return html`
    <div class="chat-tab-bar" role="tablist" aria-label=${t("chat.selectors.session")}>
      <div
        class="chat-tab-bar__tabs"
        @wheel=${(e: WheelEvent) => {
          // Horizontal scroll via trackpad or shift+vertical wheel.
          // Normalize deltaX (trackpad) and deltaY (mouse wheel) into
          // horizontal scroll so tabs push left/right when the cursor
          // hovers over the tab bar.
          const container = e.currentTarget as HTMLElement;
          if (container.scrollWidth <= container.clientWidth) return; // nothing to scroll
          const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (dx === 0) return;
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
