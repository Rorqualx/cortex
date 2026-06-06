// Chat tab bar — multi-tab session header for the chat window.
import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { type AppViewState } from "../app-view-state.ts";
import { icons } from "../icons.ts";
import { resolveSessionDisplayName } from "../session-display.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../session-key.ts";
import type { SessionsListResult } from "../types.ts";

function resolveChatTabLabel(
  state: AppViewState,
  sessionKey: string,
  sessions: SessionsListResult | null | undefined,
): string {
  const row = sessions?.sessions.find((s) => s.key === sessionKey);
  const display = resolveSessionDisplayName(sessionKey, row);
  // If it's just the raw key, shorten it
  if (display === sessionKey) {
    const parsed = parseAgentSessionKey(sessionKey);
    if (parsed?.rest) {
      return parsed.rest.length > 20 ? parsed.rest.slice(0, 20) + "…" : parsed.rest;
    }
    return sessionKey.length > 16 ? sessionKey.slice(0, 16) + "…" : sessionKey;
  }
  return display.length > 24 ? display.slice(0, 24) + "…" : display;
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

export function renderChatTabBar(
  state: AppViewState,
  options: {
    onSwitchSession: (nextKey: string) => void;
    onNewSession: () => void;
    onCloseTab: (sessionKey: string) => void;
  },
): TemplateResult {
  const { onSwitchSession, onNewSession, onCloseTab } = options;
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

  return html`
    <div class="chat-tab-bar" role="tablist" aria-label=${t("chat.selectors.session")}>
      <div class="chat-tab-bar__tabs">
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
              @click=${() => {
                if (!active) {
                  onSwitchSession(key);
                }
              }}
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
                : ""}
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
