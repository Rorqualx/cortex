// Control UI view renders channels.telegram screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { ChannelAccountSnapshot, TelegramStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  boolStatusKind,
  formatNullableBoolean,
  renderChannelAccountRow,
  renderChannelActionRow,
  renderChannelErrorRow,
  renderChannelProbeRow,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { renderSettingsSection } from "./settings-ui.ts";

export function renderTelegramCard(params: {
  props: ChannelsProps;
  telegram?: TelegramStatus;
  telegramAccounts: ChannelAccountSnapshot[];
  accountCount?: number;
}) {
  const { props, telegram, telegramAccounts, accountCount } = params;
  const hasMultipleAccounts = telegramAccounts.length > 1;
  const configured = resolveChannelConfigured("telegram", props);

  const renderAccountRow = (account: ChannelAccountSnapshot) => {
    const probe = account.probe as { bot?: { username?: string } } | undefined;
    const botUsername = probe?.bot?.username;
    const label = account.name || account.accountId;
    return renderChannelAccountRow({
      title: botUsername ? `@${botUsername}` : label,
      accountId: account.accountId,
      facts: [
        `${t("common.configured")}: ${account.configured ? t("common.yes") : t("common.no")}`,
      ],
      status: {
        kind: boolStatusKind(account.running),
        label: account.running ? t("common.running") : t("common.no"),
      },
      lastInboundAt: account.lastInboundAt,
      lastError: account.lastError,
    });
  };

  if (hasMultipleAccounts) {
    return renderSettingsSection(
      {
        title: t("channels.telegram.title"),
        description: t("channels.telegram.subtitle"),
        ...(accountCount !== undefined ? { count: accountCount } : {}),
      },
      html`
        ${telegramAccounts.map((account) => renderAccountRow(account))}
        ${telegram?.lastError ? renderChannelErrorRow(telegram.lastError) : nothing}
        ${telegram?.probe ? renderChannelProbeRow(telegram.probe) : nothing}
        ${renderChannelConfigSection({ channelId: "telegram", props })}
        ${renderChannelActionRow(
          html`<button class="btn" @click=${() => props.onRefresh(true)}>
            ${t("common.probe")}
          </button>`,
        )}
      `,
    );
  }

  return renderSingleAccountChannelCard({
    title: t("channels.telegram.title"),
    subtitle: t("channels.telegram.subtitle"),
    accountCount,
    statusRows: [
      {
        label: t("common.configured"),
        value: formatNullableBoolean(configured),
        kind: boolStatusKind(configured),
      },
      {
        label: t("common.running"),
        value: telegram?.running ? t("common.yes") : t("common.no"),
        kind: boolStatusKind(telegram?.running),
      },
      { label: t("common.mode"), value: telegram?.mode ?? t("common.na") },
      {
        label: t("common.lastStart"),
        value: telegram?.lastStartAt
          ? formatRelativeTimestamp(telegram.lastStartAt)
          : t("common.na"),
      },
      {
        label: t("common.lastProbe"),
        value: telegram?.lastProbeAt
          ? formatRelativeTimestamp(telegram.lastProbeAt)
          : t("common.na"),
      },
    ],
    lastError: telegram?.lastError,
    secondaryCallout: telegram?.probe ? renderChannelProbeRow(telegram.probe) : nothing,
    configSection: renderChannelConfigSection({ channelId: "telegram", props }),
    footer: html`<button class="btn" @click=${() => props.onRefresh(true)}>
      ${t("common.probe")}
    </button>`,
  });
}
