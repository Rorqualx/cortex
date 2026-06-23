// Control UI view renders conversations screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { agentAvatarUrl } from "../avatar/agent-avatar.ts";
import { formatRelativeTimestamp, parseSessionKeyParts } from "../format.ts";
import { icons } from "../icons.ts";
import { pathForTab } from "../navigation.ts";
import { isSessionRunActive } from "../session-run-state.ts";
import { normalizeOptionalString } from "../string-coerce.ts";
import type { AgentIdentityResult, GatewaySessionRow, SessionsListResult } from "../types.ts";

export type ConversationsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  basePath: string;
  searchQuery: string;
  agentIdentityById: Record<string, AgentIdentityResult>;
  onSearchChange: (query: string) => void;
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

function resolveConversationTitle(row: GatewaySessionRow): string {
  if (row.goal?.objective?.trim()) {
    const obj = row.goal.objective.trim();
    return obj.length > 80 ? obj.slice(0, 80) + "…" : obj;
  }
  if (row.derivedTitle && row.derivedTitle !== row.key) {
    const dt = row.derivedTitle;
    return dt.length > 80 ? dt.slice(0, 80) + "…" : dt;
  }
  if (row.llmTitle && row.llmTitle !== row.key) {
    return row.llmTitle;
  }
  if (row.label && row.label !== row.key) {
    return row.label;
  }
  if (row.displayName && row.displayName !== row.key) {
    return row.displayName;
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
    return candidate.length > 120 ? candidate.slice(0, 120) + "…" : candidate;
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

function filterConversations(rows: GatewaySessionRow[], query: string): GatewaySessionRow[] {
  const q = normalizeOptionalString(query)?.toLowerCase() ?? "";
  if (!q) {
    return rows;
  }
  return rows.filter((row) => {
    const title = resolveConversationTitle(row).toLowerCase();
    if (title.includes(q)) {
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
  });
}

export function renderConversations(props: ConversationsProps) {
  const {
    loading,
    result,
    error,
    basePath,
    searchQuery,
    agentIdentityById,
    onSearchChange,
    onRefresh,
    onNavigateToChat,
    onDelete,
    mainSessionKey,
  } = props;

  const allRows = (result?.sessions ?? []).toSorted(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );

  const filtered = filterConversations(allRows, searchQuery);

  return html`
    <div class="conversations-layout">
      <section class="conversations-toolbar">
        <div class="conversations-toolbar-row">
          <div class="conversations-search">
            <label class="field conversations-search-field">
              <input
                type="search"
                placeholder="Search conversations…"
                aria-label="Search conversations"
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
        ${error
          ? html`<div class="callout danger" style="margin-top: 8px;">${error}</div>`
          : nothing}
      </section>

      <section class="conversations-list">
        ${filtered.length === 0 && !loading
          ? html`
              <div class="card">
                <div class="card-title">No conversations found</div>
                <div class="card-sub">
                  ${allRows.length === 0
                    ? "Start chatting to create conversations."
                    : "No conversations match your search."}
                </div>
              </div>
            `
          : nothing}
        ${filtered.map((row) => {
          const title = resolveConversationTitle(row);
          const preview = resolveConversationPreview(row, title);
          const meta = resolveConversationMeta(row);
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
              <span class="conversation-row__dot" aria-hidden="true"></span>
              <span class="conversation-row__body">
                <span class="conversation-row__name">${title}</span>
                ${preview
                  ? html`<span class="conversation-row__preview">${preview}</span>`
                  : nothing}
                <span class="conversation-row__meta">
                  ${agentName}${meta ? ` · ${meta}` : ""}
                </span>
              </span>
              ${hasActiveRun
                ? html`<span class="conversation-row__live" aria-label="Active run">●</span>`
                : nothing}
              ${row.key === mainSessionKey
                ? nothing
                : html`
                    <button
                      type="button"
                      class="conversation-row__delete"
                      title="Delete conversation"
                      aria-label=${`Delete conversation: ${title}`}
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
          ${filtered.length === 1 ? "conversation" : "conversations"}
        </span>
      </div>
    </div>
  `;
}
