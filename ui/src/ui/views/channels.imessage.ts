// Control UI view renders channels.imessage screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { IMessageStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  boolStatusKind,
  formatNullableBoolean,
  renderChannelProbeRow,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderIMessageCard(params: {
  props: ChannelsProps;
  imessage?: IMessageStatus | null;
  accountCount?: number;
}) {
  const { props, imessage, accountCount } = params;
  const configured = resolveChannelConfigured("imessage", props);

  return renderSingleAccountChannelCard({
    title: t("channels.imessage.title"),
    subtitle: t("channels.imessage.subtitle"),
    accountCount,
    statusRows: [
      {
        label: t("common.configured"),
        value: formatNullableBoolean(configured),
        kind: boolStatusKind(configured),
      },
      {
        label: t("common.running"),
        value: imessage?.running ? t("common.yes") : t("common.no"),
        kind: boolStatusKind(imessage?.running),
      },
      {
        label: t("common.lastStart"),
        value: imessage?.lastStartAt
          ? formatRelativeTimestamp(imessage.lastStartAt)
          : t("common.na"),
      },
      {
        label: t("common.lastProbe"),
        value: imessage?.lastProbeAt
          ? formatRelativeTimestamp(imessage.lastProbeAt)
          : t("common.na"),
      },
    ],
    lastError: imessage?.lastError,
    secondaryCallout: imessage?.probe ? renderChannelProbeRow(imessage.probe) : nothing,
    configSection: renderChannelConfigSection({ channelId: "imessage", props }),
    footer: html`<button class="btn" @click=${() => props.onRefresh(true)}>
      ${t("common.probe")}
    </button>`,
  });
}
