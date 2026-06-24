// Control UI view renders the cross-agent activity feed: a live "Now" strip,
// a filter toolbar, and run-grouped cards (agent avatar, model, token/cost,
// duration) with expandable steps. Data comes from the gateway (history +
// live broadcast) via the activity controller; this view is presentation only.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import {
  type ActivityEvent,
  type ActivityRunGroup,
  type ActivityStatusKey,
  eventMatchesSearch,
  groupActivityRuns,
  statusKey,
} from "../activity-model.ts";
import { agentAvatarUrl } from "../avatar/agent-avatar.ts";
import { formatTimeMs } from "../format.ts";
import { icons } from "../icons.ts";
import { normalizeLowercaseStringOrEmpty, sortUniqueStrings } from "../string-coerce.ts";

const STATUS_CHIPS: ActivityStatusKey[] = ["running", "ok", "error", "blocked"];
const NOW_STRIP_LIMIT = 10;

export type ActivityProps = {
  events: ActivityEvent[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  filterText: string;
  statusFilters: Record<ActivityStatusKey, boolean>;
  kindFilter: string;
  agentFilter: string;
  expandedIds: Set<string>;
  autoFollow: boolean;
  onFilterTextChange: (next: string) => void;
  onKindFilterChange: (next: string) => void;
  onAgentFilterChange: (next: string) => void;
  onStatusToggle: (status: ActivityStatusKey, enabled: boolean) => void;
  onToggleAutoFollow: (next: boolean) => void;
  onClear: () => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onExpandAll: (ids: string[]) => void;
  onCollapseAll: () => void;
  onEntryToggle: (id: string, open: boolean) => void;
  onScroll: (event: Event) => void;
};

function formatTime(value: number): string {
  return formatTimeMs(value, { hour: "numeric", minute: "2-digit", second: "2-digit" }, "");
}

function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return "";
  }
  if (value < 1_000) {
    return t("activity.duration.ms", { count: String(Math.round(value)) });
  }
  if (value < 60_000) {
    return t("activity.duration.seconds", { count: (value / 1_000).toFixed(1) });
  }
  const roundedSeconds = Math.round(value / 1_000);
  return t("activity.duration.minutes", {
    minutes: String(Math.floor(roundedSeconds / 60)),
    seconds: String(roundedSeconds % 60),
  });
}

function statusLabel(status: ActivityStatusKey): string {
  return t(`activity.status.${status}`);
}

function kindLabel(kind: string): string {
  const known = t(`activity.kind.${kind}`);
  return known.startsWith("activity.kind.") ? kind : known;
}

function totalTokens(metrics: ActivityEvent["metrics"]): number {
  if (!metrics) {
    return 0;
  }
  return (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0);
}

function formatTokens(metrics: ActivityEvent["metrics"]): string {
  const total = totalTokens(metrics);
  if (total <= 0) {
    return "";
  }
  const label = total >= 1_000 ? `${(total / 1_000).toFixed(1)}k` : String(total);
  return t("activity.tokens", { count: label });
}

function agentName(agentId: string | undefined): string {
  return agentId ?? "—";
}

function renderAvatar(agentId: string | undefined) {
  if (!agentId) {
    return html`<span class="activity-avatar activity-avatar--none" aria-hidden="true"
      >${icons.bot}</span
    >`;
  }
  return html`<img
    class="activity-avatar"
    src=${agentAvatarUrl(agentId)}
    alt=${agentName(agentId)}
    loading="lazy"
  />`;
}

function passesFilters(props: ActivityProps, event: ActivityEvent, needle: string): boolean {
  const key = statusKey(event.status);
  // `info` rows (run boundary, thinking, plan) are context, not filterable noise.
  if (key !== "info" && !props.statusFilters[key]) {
    return false;
  }
  if (props.agentFilter && event.agentId !== props.agentFilter) {
    return false;
  }
  if (props.kindFilter && event.kind !== props.kindFilter) {
    return false;
  }
  return eventMatchesSearch(event, needle);
}

function renderNowStrip(events: ActivityEvent[]) {
  const running = events
    .filter((event) => statusKey(event.status) === "running")
    .slice(0, NOW_STRIP_LIMIT);
  return html`
    <div class="activity-now" aria-label=${t("activity.nowLabel")}>
      <span class="activity-now__label">${icons.activity} ${t("activity.nowLabel")}</span>
      ${running.length === 0
        ? html`<span class="activity-now__empty">${t("activity.nowEmpty")}</span>`
        : running.map(
            (event) => html`
              <span class="activity-now__chip" title=${event.title}>
                ${renderAvatar(event.agentId)}
                <span class="activity-now__spinner" aria-hidden="true"></span>
                <span class="activity-now__text">${event.title}</span>
              </span>
            `,
          )}
    </div>
  `;
}

function renderStep(props: ActivityProps, event: ActivityEvent) {
  const key = statusKey(event.status);
  const duration = formatDuration(event.metrics?.durationMs);
  const summary = event.detail?.summary;
  const preview = event.detail?.preview;
  const error = event.detail?.error;
  return html`
    <li class="activity-step activity-step--${key}">
      <span class="activity-dot activity-dot--${key}" aria-hidden="true"></span>
      <span class="activity-step__kind">${kindLabel(event.kind)}</span>
      <span class="activity-step__body">
        <span class="activity-step__title">${event.title}</span>
        ${summary && summary !== event.title
          ? html`<span class="activity-step__summary mono">${summary}</span>`
          : nothing}
        ${error ? html`<span class="activity-step__error">${error}</span>` : nothing}
        ${preview
          ? html`<details class="activity-step__preview">
              <summary>${t("activity.output")}</summary>
              <pre>${preview}</pre>
              ${event.detail?.truncated
                ? html`<div class="activity-step__note">${t("activity.outputTruncated")}</div>`
                : nothing}
            </details>`
          : nothing}
      </span>
      <span class="activity-step__meta">
        ${duration ? html`<span>${duration}</span>` : nothing}
        <span>${formatTime(event.ts)}</span>
      </span>
    </li>
  `;
}

function renderRun(props: ActivityProps, group: ActivityRunGroup) {
  const open = props.expandedIds.has(group.key);
  const tokens = formatTokens(group.metrics ?? group.header?.metrics);
  const duration = formatDuration(group.metrics?.durationMs ?? group.header?.metrics?.durationMs);
  const stepCount = group.steps.length;
  return html`
    <details
      class="activity-run activity-run--${group.status}"
      role="listitem"
      .open=${open}
      @toggle=${(event: Event) =>
        props.onEntryToggle(group.key, (event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary class="activity-run__summary">
        <span class="activity-run__chevron" aria-hidden="true">${icons.chevronRight}</span>
        ${renderAvatar(group.agentId)}
        <span class="activity-run__main">
          <span class="activity-run__line1">
            <span class="activity-run__agent">${agentName(group.agentId)}</span>
            <span class="activity-status activity-status--${group.status}">
              ${statusLabel(group.status)}
            </span>
            ${group.model
              ? html`<span class="activity-run__model mono">${group.model}</span>`
              : nothing}
          </span>
          <span class="activity-run__line2">
            <span
              >${stepCount === 1
                ? t("activity.stepOne")
                : t("activity.steps", { count: String(stepCount) })}</span
            >
            ${tokens ? html`<span>${tokens}</span>` : nothing}
            ${duration ? html`<span>${duration}</span>` : nothing}
            ${group.sessionKey
              ? html`<span class="activity-run__session mono">${group.sessionKey}</span>`
              : nothing}
          </span>
        </span>
        <span class="activity-run__time">${formatTime(group.latestTs)}</span>
      </summary>
      <ul class="activity-run__steps" role="list">
        ${group.steps.length === 0
          ? html`<li class="activity-step__note">${t("activity.noOutputPreview")}</li>`
          : group.steps.map((step) => renderStep(props, step))}
      </ul>
    </details>
  `;
}

export function renderActivity(props: ActivityProps) {
  const needle = normalizeLowercaseStringOrEmpty(props.filterText);
  const filtered = props.events.filter((event) => passesFilters(props, event, needle));
  const groups = groupActivityRuns(filtered);
  const kindOptions = sortUniqueStrings(props.events.map((event) => event.kind));
  const agentOptions = sortUniqueStrings(
    props.events.map((event) => event.agentId).filter((id): id is string => Boolean(id)),
  );

  return html`
    <section class="activity-page" aria-label=${t("activity.title")}>
      ${renderNowStrip(props.events)}

      <div class="activity-toolbar" aria-label=${t("activity.filtersLabel")}>
        <label class="activity-field activity-field--search">
          <span>${t("activity.search")}</span>
          <input
            type="search"
            .value=${props.filterText}
            placeholder=${t("activity.searchPlaceholder")}
            @input=${(event: Event) =>
              props.onFilterTextChange((event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="activity-field">
          <span>${t("activity.agentFilter")}</span>
          <select
            .value=${props.agentFilter}
            @change=${(event: Event) =>
              props.onAgentFilterChange((event.target as HTMLSelectElement).value)}
          >
            <option value="">${t("activity.allAgents")}</option>
            ${agentOptions.map((id) => html`<option value=${id}>${id}</option>`)}
          </select>
        </label>
        <label class="activity-field">
          <span>${t("activity.kindFilter")}</span>
          <select
            .value=${props.kindFilter}
            @change=${(event: Event) =>
              props.onKindFilterChange((event.target as HTMLSelectElement).value)}
          >
            <option value="">${t("activity.allKinds")}</option>
            ${kindOptions.map((kind) => html`<option value=${kind}>${kindLabel(kind)}</option>`)}
          </select>
        </label>
        <div class="activity-status-filters" role="group" aria-label=${t("activity.statusFilters")}>
          ${STATUS_CHIPS.map(
            (status) => html`
              <label class="activity-status-filter activity-status-filter--${status}">
                <input
                  type="checkbox"
                  .checked=${props.statusFilters[status]}
                  @change=${(event: Event) =>
                    props.onStatusToggle(status, (event.target as HTMLInputElement).checked)}
                />
                <span>${statusLabel(status)}</span>
              </label>
            `,
          )}
        </div>
        <label class="activity-autofollow">
          <input
            type="checkbox"
            .checked=${props.autoFollow}
            @change=${(event: Event) =>
              props.onToggleAutoFollow((event.target as HTMLInputElement).checked)}
          />
          <span>${t("activity.autoFollow")}</span>
        </label>
        <div class="activity-actions">
          <button type="button" class="btn btn--sm" @click=${props.onRefresh}>
            ${icons.refresh} ${t("activity.refresh")}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${groups.length === 0}
            @click=${() => props.onExpandAll(groups.map((group) => group.key))}
          >
            ${t("activity.expandAll")}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${props.expandedIds.size === 0}
            @click=${props.onCollapseAll}
          >
            ${t("activity.collapseAll")}
          </button>
          <button
            type="button"
            class="btn btn--sm danger"
            ?disabled=${props.events.length === 0}
            @click=${props.onClear}
          >
            ${t("activity.clear")}
          </button>
        </div>
        <div class="activity-toolbar__count" aria-live="polite">
          ${t("activity.visibleCount", {
            visible: String(groups.length),
            total: String(props.events.length),
          })}
        </div>
      </div>

      ${props.error ? html`<div class="activity-error">${props.error}</div>` : nothing}

      <div
        class="activity-stream"
        role="list"
        aria-label=${t("activity.streamLabel")}
        @scroll=${props.onScroll}
      >
        ${groups.length === 0
          ? html`<div class="activity-empty">
              ${props.loading
                ? t("activity.loading")
                : props.events.length === 0
                  ? t("activity.empty")
                  : t("activity.emptyFiltered")}
            </div>`
          : groups.map((group) => renderRun(props, group))}
        ${props.hasMore
          ? html`<div class="activity-more">
              <button
                type="button"
                class="btn btn--sm"
                ?disabled=${props.loading}
                @click=${props.onLoadMore}
              >
                ${props.loading ? t("activity.loading") : t("activity.loadMore")}
              </button>
            </div>`
          : nothing}
      </div>
    </section>
  `;
}
