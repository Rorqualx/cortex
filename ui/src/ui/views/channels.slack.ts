// Control UI view renders channels.slack screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { SlackStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  boolStatusKind,
  formatNullableBoolean,
  renderChannelProbeRow,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderSlackCard(params: {
  props: ChannelsProps;
  slack?: SlackStatus | null;
  accountCount?: number;
}) {
  const { props, slack, accountCount } = params;
  const configured = resolveChannelConfigured("slack", props);

  return renderSingleAccountChannelCard({
    title: t("channels.slack.title"),
    subtitle: t("channels.slack.subtitle"),
    accountCount,
    statusRows: [
      {
        label: t("common.configured"),
        value: formatNullableBoolean(configured),
        kind: boolStatusKind(configured),
      },
      {
        label: t("common.running"),
        value: slack?.running ? t("common.yes") : t("common.no"),
        kind: boolStatusKind(slack?.running),
      },
      {
        label: t("common.lastStart"),
        value: slack?.lastStartAt ? formatRelativeTimestamp(slack.lastStartAt) : t("common.na"),
      },
      {
        label: t("common.lastProbe"),
        value: slack?.lastProbeAt ? formatRelativeTimestamp(slack.lastProbeAt) : t("common.na"),
      },
    ],
    lastError: slack?.lastError,
    secondaryCallout: slack?.probe ? renderChannelProbeRow(slack.probe) : nothing,
    configSection: renderChannelConfigSection({ channelId: "slack", props }),
    footer: html`<button class="btn" @click=${() => props.onRefresh(true)}>
      ${t("common.probe")}
    </button>`,
  });
}
