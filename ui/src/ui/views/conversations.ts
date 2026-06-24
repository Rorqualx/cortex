// Control UI view renders conversations screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { agentAvatarUrl } from "../avatar/agent-avatar.ts";
import { clampText, formatRelativeTimestamp, parseSessionKeyParts } from "../format.ts";
import { icons } from "../icons.ts";
import { pathForTab } from "../navigation.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import { normalizeOptionalString } from "../string-coerce.ts";
import type { AgentIdentityResult, GatewaySessionRow, SessionsListResult } from "../types.ts";

/** Source bucket a session belongs to, for the filter chips + row badge. */
export type ConversationSource = "chat" | "cron" | "channel";
export type ConversationFilter = "all" | ConversationSource;

const FILTER_ORDER: ConversationFilter[] = ["all", "chat", "cron", "channel"];

// Session-key channels that are local dashboard/CLI chats, not external channels.
const LOCAL_CHANNELS = new Set(["main", "dashboard", "webchat", "local", "cli"]);

export type ConversationsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  basePath: string;
  searchQuery: string;
  sourceFilter: ConversationFilter;
  agentIdentityById: Record<string, AgentIdentityResult>;
  onSearchChange: (query: string) => void;
  onSourceFilterChange: (filter: ConversationFilter) => void;
  onRefresh: () => void;
  onNavigateToChat: (sessionKey: string) => void;
  onDelete: (sessionKey: string) => void;
  /** The gateway refuses to delete this session; hide the delete action for it. */
  mainSessionKey: string;
};

function resolveAgentName(
  agentIdentityById: Record<string, AgentIdentityResult>,
  agentId: string,
): string {
  const identity = Object.hasOwn(agentIdentityById, agentId)
    ? (agentIdentityById[agentId] ?? null)
    : null;
  return normalizeOptionalString(identity?.name) || agentId;
}

/** Buckets a session into chat / cron / channel for filtering + badging. */
export function classifyConversation(row: GatewaySessionRow): ConversationSource {
  const parsed = parseSessionKeyParts(row.key);
  // Cron sessions are keyed agent:<id>:cron:<uuid> (channel "cron") and labeled
  // "Cron: <name>"; either signal classifies them as cron.
  if (row.key.startsWith("cron:") || parsed?.channel === "cron" || row.label?.startsWith("Cron:")) {
    return "cron";
  }
  if (parsed && !LOCAL_CHANNELS.has(parsed.channel)) {
    return "channel";
  }
  return "chat";
}

/** Short source label shown as a row badge (channel name for channel rows). */
function conversationBadge(row: GatewaySessionRow, source: ConversationSource): string | null {
  if (source === "cron") {
    return t("conversations.badgeCron");
  }
  if (source === "channel") {
    return parseSessionKeyParts(row.key)?.channel ?? null;
  }
  return null;
}

function resolveConversationTitle(row: GatewaySessionRow): string {
  if (row.goal?.objective?.trim()) {
    return clampText(row.goal.objective.trim(), 80);
  }
  // llmTitle and derivedTitle are both cleaned server-side; the AI title is the
  // more human of the two so it leads.
  if (row.llmTitle && row.llmTitle !== row.key) {
    return clampText(row.llmTitle, 80);
  }
  if (row.derivedTitle && row.derivedTitle !== row.key) {
    return clampText(row.derivedTitle, 80);
  }
  if (row.label && row.label !== row.key) {
    return clampText(row.label, 80);
  }
  if (row.displayName && row.displayName !== row.key) {
    return clampText(row.displayName, 80);
  }
  const parsed = parseSessionKeyParts(row.key);
  if (parsed) {
    const rest = `${parsed.channel}:${parsed.accountId}`;
    if (rest !== "main") {
      return rest;
    }
  }
  return row.key;
}

function resolveConversationPreview(row: GatewaySessionRow, title: string): string | null {
  // The thread's first user message is the canonical preview; metadata titles
  // are fallbacks for sessions whose transcript has no readable first message.
  const candidates = [
    row.firstMessagePreview,
    row.derivedTitle,
    row.goal?.objective,
    row.llmTitle,
    row.subject,
    row.displayName,
    row.label,
  ];
  for (const raw of candidates) {
    const candidate = normalizeOptionalString(raw)?.trim();
    if (!candidate || candidate === title || candidate === row.key) {
      continue;
    }
    return clampText(candidate, 120);
  }
  return null;
}

function resolveConversationMeta(row: GatewaySessionRow): string {
  const parts: string[] = [];
  if (row.modelProvider && row.model) {
    parts.push(`${row.modelProvider}/${row.model}`);
  } else if (row.model) {
    parts.push(row.model);
  }
  if (row.updatedAt) {
    parts.push(formatRelativeTimestamp(row.updatedAt));
  }
  return parts.join(" · ");
}

function matchesSearch(row: GatewaySessionRow, title: string, q: string): boolean {
  if (title.toLowerCase().includes(q)) {
    return true;
  }
  if (row.key.toLowerCase().includes(q)) {
    return true;
  }
  if (row.firstMessagePreview?.toLowerCase().includes(q)) {
    return true;
  }
  if (row.goal?.objective?.toLowerCase().includes(q)) {
    return true;
  }
  if (row.derivedTitle?.toLowerCase().includes(q)) {
    return true;
  }
  if (row.label?.toLowerCase().includes(q)) {
    return true;
  }
  return false;
}

function filterConversations(
  rows: GatewaySessionRow[],
  query: string,
  sourceFilter: ConversationFilter,
): GatewaySessionRow[] {
  const q = normalizeOptionalString(query)?.toLowerCase() ?? "";
  return rows.filter((row) => {
    if (sourceFilter !== "all" && classifyConversation(row) !== sourceFilter) {
      return false;
    }
    if (!q) {
      return true;
    }
    return matchesSearch(row, resolveConversationTitle(row), q);
  });
}

function filterLabel(filter: ConversationFilter): string {
  const key = filter === "channel" ? "channels" : filter === "chat" ? "chats" : filter;
  return t(`conversations.filters.${key}`);
}

export function renderConversations(props: ConversationsProps) {
  const {
    loading,
    result,
    error,
    basePath,
    searchQuery,
    sourceFilter,
    agentIdentityById,
    onSearchChange,
    onSourceFilterChange,
    onRefresh,
    onNavigateToChat,
    onDelete,
    mainSessionKey,
  } = props;

  const allRows = (result?.sessions ?? []).toSorted(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );

  // Chip counts respect the search query but ignore the active source filter so
  // each chip always shows how many sessions of that source match the search.
  const searchScoped = filterConversations(allRows, searchQuery, "all");
  const counts: Record<ConversationFilter, number> = {
    all: searchScoped.length,
    chat: 0,
    cron: 0,
    channel: 0,
  };
  for (const row of searchScoped) {
    counts[classifyConversation(row)] += 1;
  }

  const filtered = filterConversations(allRows, searchQuery, sourceFilter);

  return html`
    <div class="conversations-layout">
      <section class="conversations-toolbar">
        <div class="conversations-toolbar-row">
          <div class="conversations-search">
            <label class="field conversations-search-field">
              <input
                type="search"
                placeholder=${t("conversations.searchPlaceholder")}
                aria-label=${t("conversations.searchLabel")}
                .value=${searchQuery}
                @input=${(e: Event) => onSearchChange((e.target as HTMLInputElement).value)}
              />
            </label>
          </div>
          <button
            class="btn btn--sm conversations-refresh-btn"
            ?disabled=${loading}
            @click=${onRefresh}
          >
            ${loading ? t("common.loading") : t("common.refresh")}
          </button>
        </div>
        <div
          class="conversations-filters"
          role="group"
          aria-label=${t("conversations.searchLabel")}
        >
          ${FILTER_ORDER.map(
            (filter) => html`
              <button
                type="button"
                class="conversations-filter ${sourceFilter === filter
                  ? "conversations-filter--active"
                  : ""}"
                aria-pressed=${sourceFilter === filter}
                @click=${() => onSourceFilterChange(filter)}
              >
                <span>${filterLabel(filter)}</span>
                <span class="conversations-filter__count">${counts[filter]}</span>
              </button>
            `,
          )}
        </div>
        ${error
          ? html`<div class="callout danger" style="margin-top: 8px;">${error}</div>`
          : nothing}
      </section>

      <section class="conversations-list">
        ${filtered.length === 0 && !loading
          ? html`
              <div class="card">
                <div class="card-title">${t("conversations.emptyTitle")}</div>
                <div class="card-sub">
                  ${allRows.length === 0
                    ? t("conversations.emptyNone")
                    : t("conversations.emptyFiltered")}
                </div>
              </div>
            `
          : nothing}
        ${filtered.map((row) => {
          const source = classifyConversation(row);
          const title = resolveConversationTitle(row);
          const preview = resolveConversationPreview(row, title);
          const meta = resolveConversationMeta(row);
          const badge = conversationBadge(row, source);
          const parsed = parseSessionKeyParts(row.key);
          const agentId = parsed?.agentId ?? "main";
          const agentName = resolveAgentName(agentIdentityById, agentId);
          const href = `${pathForTab("chat", basePath)}?session=${encodeURIComponent(row.key)}`;
          const hasActiveRun = row.hasActiveRun || isSessionRunActive(row);

          return html`
            <a
              href=${href}
              class="conversation-row"
              title=${`${title}${preview ? " · " + preview : ""} · ${row.key}`}
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
                onNavigateToChat(row.key);
              }}
            >
              <img
                class="conversation-row__avatar"
                src=${agentAvatarUrl(agentId, { avatar: agentIdentityById[agentId]?.avatar })}
                alt=""
                aria-hidden="true"
              />
              <span class="conversation-row__body">
                <span class="conversation-row__name">${title}</span>
                ${preview
                  ? html`<span class="conversation-row__preview">${preview}</span>`
                  : nothing}
                <span class="conversation-row__meta">
                  ${agentName}${meta ? ` · ${meta}` : ""}
                </span>
              </span>
              ${badge
                ? html`<span class="conversation-row__badge conversation-row__badge--${source}"
                    >${badge}</span
                  >`
                : nothing}
              ${hasActiveRun
                ? html`<span
                    class="conversation-row__live"
                    aria-label=${t("conversations.activeRun")}
                    >●</span
                  >`
                : nothing}
              ${row.key === mainSessionKey
                ? nothing
                : html`
                    <button
                      type="button"
                      class="conversation-row__delete"
                      title=${t("conversations.delete")}
                      aria-label=${`${t("conversations.delete")}: ${title}`}
                      @click=${(event: MouseEvent) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onDelete(row.key);
                      }}
                    >
                      ${icons.trash}
                    </button>
                  `}
            </a>
          `;
        })}
      </section>

      <div class="conversations-footer">
        <span class="conversations-count">
          ${filtered.length}${allRows.length !== filtered.length ? ` / ${allRows.length}` : ""}
          ${filtered.length === 1 ? t("conversations.countOne") : t("conversations.countOther")}
        </span>
      </div>
    </div>
  `;
}
