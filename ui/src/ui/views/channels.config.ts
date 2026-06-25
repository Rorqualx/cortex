// Control UI view renders channels screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { ConfigUiHints } from "../types.ts";
import { formatChannelExtraValue, resolveChannelConfigValue } from "./channel-config-extras.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { analyzeConfigSchema, renderNode, schemaType, type JsonSchema } from "./config-form.ts";

type AccountStatus = {
  running?: boolean | null;
  configured?: boolean | null;
  lastInboundAt?: number | null;
};

// The few fields needed to get a channel working stay visible; everything else
// is folded away so the form is not an overwhelming wall of ~40 inputs.
const PRIMARY_CHANNEL_FIELD_KEYS = new Set([
  "enabled",
  "token",
  "botToken",
  "dmPolicy",
  "groupPolicy",
  "allowFrom",
  "groupAllowFrom",
]);

type ChannelFieldGroupId = "setup" | "security" | "advanced";

const CHANNEL_FIELD_GROUPS: Array<{ id: ChannelFieldGroupId; label: string; open: boolean }> = [
  { id: "setup", label: "Setup", open: true },
  { id: "security", label: "Security & access", open: false },
  { id: "advanced", label: "Advanced", open: false },
];

function channelFieldTags(node: JsonSchema): string[] {
  const record = node as Record<string, unknown>;
  const raw = record["x-tags"] ?? record.tags;
  return Array.isArray(raw) ? raw.map((tag) => String(tag).toLowerCase()) : [];
}

function categorizeChannelField(key: string, node: JsonSchema): ChannelFieldGroupId {
  if (PRIMARY_CHANNEL_FIELD_KEYS.has(key)) {
    return "setup";
  }
  const tags = channelFieldTags(node);
  const securityish = tags.some((tag) => tag === "security" || tag === "auth" || tag === "access");
  if (key.toLowerCase().startsWith("webhook") || securityish) {
    return "security";
  }
  return "advanced";
}

type ChannelConfigFormProps = {
  channelId: string;
  configValue: Record<string, unknown> | null;
  schema: unknown;
  uiHints: ConfigUiHints;
  disabled: boolean;
  accountStatus?: Record<string, AccountStatus>;
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

function formatStatusBoolean(value: boolean | null | undefined): string {
  if (value === true) {
    return t("common.yes");
  }
  if (value === false) {
    return t("common.no");
  }
  return t("common.na");
}

// Live status (from the gateway snapshot) shown in an account scope header so the
// container reads at a glance before it is expanded to reveal the config fields.
function renderAccountStatusTiles(status: AccountStatus) {
  return html`
    <div class="status-list account-card-status">
      <div>
        <span class="label">${t("common.running")}</span>
        <span>${formatStatusBoolean(status.running)}</span>
      </div>
      <div>
        <span class="label">${t("common.configured")}</span>
        <span>${formatStatusBoolean(status.configured)}</span>
      </div>
      <div>
        <span class="label">${t("common.lastInbound")}</span>
        <span>
          ${status.lastInboundAt ? formatRelativeTimestamp(status.lastInboundAt) : t("common.na")}
        </span>
      </div>
    </div>
  `;
}

function resolveSchemaNode(
  schema: JsonSchema | null,
  path: Array<string | number>,
): JsonSchema | null {
  let current = schema;
  for (const key of path) {
    if (!current) {
      return null;
    }
    const type = schemaType(current);
    if (type === "object") {
      const properties = current.properties ?? {};
      if (typeof key === "string" && properties[key]) {
        current = properties[key];
        continue;
      }
      const additional = current.additionalProperties;
      if (typeof key === "string" && additional && typeof additional === "object") {
        current = additional;
        continue;
      }
      return null;
    }
    if (type === "array") {
      if (typeof key !== "number") {
        return null;
      }
      const items = Array.isArray(current.items) ? current.items[0] : current.items;
      current = items ?? null;
      continue;
    }
    return null;
  }
  return current;
}

function resolveChannelValue(
  config: Record<string, unknown>,
  channelId: string,
): Record<string, unknown> {
  return resolveChannelConfigValue(config, channelId) ?? {};
}

const EXTRA_CHANNEL_FIELDS = ["groupPolicy", "streamMode", "dmPolicy"] as const;

function renderExtraChannelFields(value: Record<string, unknown>) {
  const entries = EXTRA_CHANNEL_FIELDS.flatMap((field) => {
    if (!(field in value)) {
      return [];
    }
    return [[field, value[field]]] as Array<[string, unknown]>;
  });
  if (entries.length === 0) {
    return null;
  }
  return html`
    <div class="status-list" style="margin-top: 12px;">
      ${entries.map(
        ([field, raw]) => html`
          <div>
            <span class="label">${field}</span>
            <span>${formatChannelExtraValue(raw)}</span>
          </div>
        `,
      )}
    </div>
  `;
}

type ChannelFieldGroupCtx = {
  hints: ConfigUiHints;
  unsupported: Set<string>;
  disabled: boolean;
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function renderChannelConfigForm(props: ChannelConfigFormProps) {
  const analysis = analyzeConfigSchema(props.schema);
  const normalized = analysis.schema;
  if (!normalized) {
    return html` <div class="callout danger">Schema unavailable. Use Raw.</div> `;
  }
  const node = resolveSchemaNode(normalized, ["channels", props.channelId]);
  if (!node) {
    return html` <div class="callout danger">Channel config schema unavailable.</div> `;
  }
  const value = resolveChannelValue(props.configValue ?? {}, props.channelId);
  const basePath = ["channels", props.channelId];
  const ctx: ChannelFieldGroupCtx = {
    hints: props.uiHints,
    unsupported: new Set(analysis.unsupportedPaths),
    disabled: props.disabled,
    onPatch: props.onPatch,
  };

  const properties = schemaType(node) === "object" ? (node.properties ?? null) : null;
  const additional = node.additionalProperties;
  // `additionalProperties: true` is JSON-Schema-equivalent to `{}`; both mean
  // free-form keys, so the grouped layout (which only renders fixed properties)
  // would silently drop them — fall back to the flat render in that case too.
  const hasAdditional =
    additional === true || (typeof additional === "object" && additional !== null);

  // Schemas with free-form additional keys at the root still use the flat render
  // so no field is dropped; fixed-property channel schemas get the grouped,
  // per-account layout below.
  if (!properties || hasAdditional) {
    return html`
      <div class="config-form">
        ${renderNode({
          schema: node,
          value,
          path: basePath,
          hints: ctx.hints,
          unsupported: ctx.unsupported,
          disabled: ctx.disabled,
          showLabel: false,
          onPatch: ctx.onPatch,
        })}
      </div>
      ${renderExtraChannelFields(value)}
    `;
  }

  // Per-account config lives under accounts.<id>; surface each configured account
  // as its own collapsible scope so operators edit a specific bot's settings
  // instead of digging through one buried "Accounts" map.
  const accounts = asRecord(value.accounts);
  const accountIds = Object.keys(accounts);
  const accountNode =
    accountIds.length > 0
      ? resolveSchemaNode(normalized, [...basePath, "accounts", accountIds[0]])
      : null;
  const accountProps =
    accountNode && schemaType(accountNode) === "object" ? (accountNode.properties ?? null) : null;
  const hasAccountScopes = accountIds.length > 0 && Boolean(accountProps);

  const accountScopes = hasAccountScopes
    ? accountIds.map((id) => {
        const accountValue = asRecord(accounts[id]);
        const name =
          typeof accountValue.name === "string" && accountValue.name.trim()
            ? accountValue.name
            : id;
        const status = props.accountStatus?.[id];
        const running = status?.running === true;
        return html`
          <details class="cfg-account">
            <summary class="cfg-account__header">
              <div class="cfg-account__head-top">
                <span class="cfg-account__dot ${running ? "is-on" : "is-off"}"></span>
                <span class="cfg-account__name">${name}</span>
                <span class="cfg-account__id">${id}</span>
                <span class="cfg-account__chevron" aria-hidden="true"></span>
              </div>
              ${status ? renderAccountStatusTiles(status) : nothing}
            </summary>
            <div class="cfg-account__body">
              ${renderGroupedFields(
                accountProps!,
                [...basePath, "accounts", id],
                accountValue,
                ctx,
              )}
            </div>
          </details>
        `;
      })
    : [];

  // When account scopes are shown, fold the shared channel-wide settings (minus
  // the now-redundant accounts map) into one more collapsed scope.
  const channelDefaults = hasAccountScopes
    ? html`
        <details class="cfg-account">
          <summary class="cfg-account__header">
            <div class="cfg-account__head-top">
              <span class="cfg-account__name">Channel defaults</span>
              <span class="cfg-account__id">shared</span>
              <span class="cfg-account__chevron" aria-hidden="true"></span>
            </div>
          </summary>
          <div class="cfg-account__body">
            ${renderGroupedFields(properties, basePath, value, ctx, new Set(["accounts"]))}
          </div>
        </details>
      `
    : renderGroupedFields(properties, basePath, value, ctx);

  return html`
    <div class="cfg-scopes">${accountScopes}${channelDefaults}</div>
    ${renderExtraChannelFields(value)}
  `;
}

function renderGroupedFields(
  properties: Record<string, JsonSchema>,
  basePath: Array<string | number>,
  value: Record<string, unknown>,
  ctx: ChannelFieldGroupCtx,
  excludeKeys?: Set<string>,
) {
  const grouped: Record<ChannelFieldGroupId, Array<[string, JsonSchema]>> = {
    setup: [],
    security: [],
    advanced: [],
  };
  for (const [key, child] of Object.entries(properties)) {
    if (excludeKeys?.has(key)) {
      continue;
    }
    grouped[categorizeChannelField(key, child)].push([key, child]);
  }

  const renderField = (key: string, child: JsonSchema) =>
    renderNode({
      schema: child,
      value: value[key],
      path: [...basePath, key],
      hints: ctx.hints,
      unsupported: ctx.unsupported,
      disabled: ctx.disabled,
      showLabel: true,
      onPatch: ctx.onPatch,
    });

  return html`
    <div class="cfg-groups">
      ${CHANNEL_FIELD_GROUPS.map((group) => {
        const fields = grouped[group.id].toSorted((a, b) => a[0].localeCompare(b[0]));
        if (fields.length === 0) {
          return nothing;
        }
        return html`
          <details class="cfg-group" ?open=${group.open}>
            <summary class="cfg-group__header">
              <span class="cfg-group__title">${group.label}</span>
              <span class="cfg-group__count">${fields.length}</span>
              <span class="cfg-group__chevron" aria-hidden="true"></span>
            </summary>
            <div class="cfg-group__content">
              <div class="cfg-fields cfg-fields--inline">
                ${fields.map(([key, child]) => renderField(key, child))}
              </div>
            </div>
          </details>
        `;
      })}
    </div>
  `;
}

export function renderChannelConfigSection(params: { channelId: string; props: ChannelsProps }) {
  const { channelId, props } = params;
  const disabled = props.configSaving || props.configSchemaLoading;
  const accounts = props.snapshot?.channelAccounts?.[channelId] ?? [];
  const accountStatus: Record<string, AccountStatus> = Object.fromEntries(
    accounts.map((account) => [
      account.accountId,
      {
        running: account.running,
        configured: account.configured,
        lastInboundAt: account.lastInboundAt,
      },
    ]),
  );
  return html`
    <div style="margin-top: 16px;">
      ${props.configSchemaLoading
        ? html` <div class="muted">Loading config schema…</div> `
        : renderChannelConfigForm({
            channelId,
            configValue: props.configForm,
            schema: props.configSchema,
            uiHints: props.configUiHints,
            disabled,
            accountStatus,
            onPatch: props.onConfigPatch,
          })}
      <div class="row" style="margin-top: 12px;">
        <button
          class="btn primary"
          ?disabled=${disabled || !props.configFormDirty}
          @click=${() => props.onConfigSave()}
        >
          ${props.configSaving ? "Saving…" : "Save"}
        </button>
        <button class="btn" ?disabled=${disabled} @click=${() => props.onConfigReload()}>
          ${t("common.reload")}
        </button>
      </div>
    </div>
  `;
}
