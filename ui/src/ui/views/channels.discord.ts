// Control UI view renders channelsiscord screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { DiscordStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  boolStatusKind,
  formatNullableBoolean,
  renderChannelProbeRow,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderDiscordCard(params: {
  props: ChannelsProps;
  discord?: DiscordStatus | null;
  accountCount?: number;
}) {
  const { props, discord, accountCount } = params;
  const configured = resolveChannelConfigured("discord", props);

  return renderSingleAccountChannelCard({
    title: t("channels.discord.title"),
    subtitle: t("channels.discord.subtitle"),
    accountCount,
    statusRows: [
      {
        label: t("common.configured"),
        value: formatNullableBoolean(configured),
        kind: boolStatusKind(configured),
      },
      {
        label: t("common.running"),
        value: discord?.running ? t("common.yes") : t("common.no"),
        kind: boolStatusKind(discord?.running),
      },
      {
        label: t("common.lastStart"),
        value: discord?.lastStartAt ? formatRelativeTimestamp(discord.lastStartAt) : t("common.na"),
      },
      {
        label: t("common.lastProbe"),
        value: discord?.lastProbeAt ? formatRelativeTimestamp(discord.lastProbeAt) : t("common.na"),
      },
    ],
    lastError: discord?.lastError,
    secondaryCallout: discord?.probe ? renderChannelProbeRow(discord.probe) : nothing,
    configSection: renderChannelConfigSection({ channelId: "discord", props }),
    footer: html`<button class="btn" @click=${() => props.onRefresh(true)}>
      ${t("common.probe")}
    </button>`,
  });
}
