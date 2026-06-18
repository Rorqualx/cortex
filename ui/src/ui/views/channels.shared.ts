// Control UI view renders channels.shared screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { ChannelAccountSnapshot } from "../types.ts";
import type { ChannelKey, ChannelsProps } from "./channels.types.ts";

type ChannelDisplayState = {
  configured: boolean | null;
  running: boolean | null;
  connected: boolean | null;
  defaultAccount: ChannelAccountSnapshot | null;
  hasAnyActiveAccount: boolean;
  status: Record<string, unknown> | undefined;
};

type ChannelStatusRow = {
  label: string;
  value: unknown;
};

/** At-a-glance channel state shown as a pill in the card header. */
export type ChannelStatusBadge = {
  label: string;
  tone: "ok" | "warn" | "idle";
};

/** Derive the header pill from the canonical configured/running flags. */
export function resolveChannelStatusBadge(
  configured: boolean | null,
  running: boolean | null,
): ChannelStatusBadge {
  if (running === true) {
    return { label: t("common.running"), tone: "ok" };
  }
  if (configured === true) {
    return { label: t("channels.status.stopped"), tone: "warn" };
  }
  return { label: t("channels.status.notConfigured"), tone: "idle" };
}

function renderChannelStatusBadge(status: ChannelStatusBadge | undefined) {
  if (!status) {
    return nothing;
  }
  return html`
    <span class="channel-badge channel-badge--${status.tone}">
      <span class="channel-badge__dot"></span>${status.label}
    </span>
  `;
}

function resolveChannelStatus(
  key: ChannelKey,
  props: ChannelsProps,
): Record<string, unknown> | undefined {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  return channels?.[key] as Record<string, unknown> | undefined;
}

export function resolveDefaultChannelAccount(
  key: ChannelKey,
  props: ChannelsProps,
): ChannelAccountSnapshot | null {
  const accounts = props.snapshot?.channelAccounts?.[key] ?? [];
  const defaultAccountId = props.snapshot?.channelDefaultAccountId?.[key];
  return (
    (defaultAccountId
      ? accounts.find((account) => account.accountId === defaultAccountId)
      : undefined) ??
    accounts[0] ??
    null
  );
}

export function resolveChannelDisplayState(
  key: ChannelKey,
  props: ChannelsProps,
): ChannelDisplayState {
  const status = resolveChannelStatus(key, props);
  const accounts = props.snapshot?.channelAccounts?.[key] ?? [];
  const defaultAccount = resolveDefaultChannelAccount(key, props);
  const configured =
    typeof status?.configured === "boolean"
      ? status.configured
      : typeof defaultAccount?.configured === "boolean"
        ? defaultAccount.configured
        : null;
  const running = typeof status?.running === "boolean" ? status.running : null;
  const connected = typeof status?.connected === "boolean" ? status.connected : null;
  const hasAnyActiveAccount = accounts.some(
    (account) => account.configured || account.running || account.connected,
  );

  return {
    configured,
    running,
    connected,
    defaultAccount,
    hasAnyActiveAccount,
    status,
  };
}

export function channelEnabled(key: ChannelKey, props: ChannelsProps) {
  if (!props.snapshot) {
    return false;
  }
  const displayState = resolveChannelDisplayState(key, props);
  return (
    displayState.configured === true ||
    displayState.running === true ||
    displayState.connected === true ||
    displayState.hasAnyActiveAccount
  );
}

export function resolveChannelConfigured(key: ChannelKey, props: ChannelsProps): boolean | null {
  return resolveChannelDisplayState(key, props).configured;
}

export function formatNullableBoolean(value: boolean | null): string {
  if (value == null) {
    return t("common.na");
  }
  return value ? t("common.yes") : t("common.no");
}

export function renderSingleAccountChannelCard(params: {
  title: string;
  subtitle: string;
  status?: ChannelStatusBadge;
  accountCountLabel: unknown;
  statusRows: readonly ChannelStatusRow[];
  lastError?: string | null;
  secondaryCallout?: unknown;
  extraContent?: unknown;
  configSection: unknown;
  footer?: unknown;
}) {
  return html`
    <div class="card channel-card">
      <div class="channel-card__head">
        <div class="channel-card__heading">
          <div class="card-title">${params.title}</div>
          <div class="card-sub">${params.subtitle}</div>
        </div>
        ${renderChannelStatusBadge(params.status)}
      </div>
      ${params.accountCountLabel}

      <div class="channel-status-strip">
        ${params.statusRows.map(
          (row) => html`
            <div class="channel-stat">
              <span class="channel-stat__label">${row.label}</span>
              <span class="channel-stat__value">${row.value}</span>
            </div>
          `,
        )}
      </div>

      ${params.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">${params.lastError}</div>`
        : nothing}
      ${params.secondaryCallout ?? nothing} ${params.extraContent ?? nothing}
      ${params.configSection} ${params.footer ?? nothing}
    </div>
  `;
}

export function getChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
): number {
  return channelAccounts?.[key]?.length ?? 0;
}

export function renderChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
) {
  const count = getChannelAccountCount(key, channelAccounts);
  if (count < 2) {
    return nothing;
  }
  return html`<div class="account-count">Accounts (${count})</div>`;
}
