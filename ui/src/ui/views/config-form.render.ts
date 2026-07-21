// Control UI view renders config form.render screen content.
import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import type { ConfigUiHints } from "../types.ts";
import { SECTION_META } from "./config-form.meta.ts";
import { renderNode } from "./config-form.node.ts";
import { matchesConfigSectionSearch, parseConfigSearchQuery } from "./config-form.search.ts";
import { hintForPath, humanize, schemaType, type JsonSchema } from "./config-form.shared.ts";
import { renderSettingsEmpty, renderSettingsPage } from "./settings-ui.ts";

export type ConfigFormProps = {
  schema: JsonSchema | null;
  uiHints: ConfigUiHints;
  value: Record<string, unknown> | null;
  rawAvailable?: boolean;
  disabled?: boolean;
  unsupportedPaths?: string[];
  searchQuery?: string;
  activeSection?: string | null;
  activeSubsection?: string | null;
  /** Inline actions rendered next to the active section heading (e.g. env peek). */
  sectionActions?: TemplateResult;
  /** Composite pages render custom rows above the form; an empty schema
   *  section must stay silent there instead of claiming the page is empty. */
  embedded?: boolean;
  revealSensitive?: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  /** When set, the channels section renders its entries as tiles that open a
      focused config modal (see config.ts) instead of inline collapsibles. Omit
      it when rendering the modal body so the scoped form renders normally. */
  onOpenChannelModal?: (sectionKey: string, key: string) => void;
};

function matchesSearch(params: {
  key: string;
  schema: JsonSchema;
  sectionValue: unknown;
  uiHints: ConfigUiHints;
  query: string;
}): boolean {
  const meta = SECTION_META[params.key];
  return matchesConfigSectionSearch({
    key: params.key,
    schema: params.schema,
    value: params.sectionValue,
    hints: params.uiHints,
    query: params.query,
    label: meta?.label,
    description: meta?.description,
  });
}

// Focused per-channel config overlay. Opens when a channels-section tile is
// clicked; the body reuses the scoped subsection render so the modal shows just
// that one channel's form. Shared by the config editor (config.ts) and the
// consolidated Channels tab (channels.ts).
export function renderChannelConfigModal(params: {
  channelKey: string | null;
  schema: JsonSchema | null;
  unsupportedPaths?: string[];
  uiHints: ConfigUiHints;
  value: Record<string, unknown> | null;
  rawAvailable: boolean;
  disabled: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  onClose: () => void;
}) {
  const key = params.channelKey;
  if (!key || !params.schema) {
    return nothing;
  }
  const channelSchema = params.schema.properties?.channels?.properties?.[key];
  const label = channelSchema?.title ?? humanize(key);
  return html`
    <div
      class="channel-modal"
      @click=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) {
          params.onClose();
        }
      }}
    >
      <div class="channel-modal__panel" role="dialog" aria-modal="true" aria-label=${label}>
        <div class="channel-modal__head">
          <div class="channel-modal__title">${label}</div>
          <button class="channel-modal__close" aria-label="Close" @click=${params.onClose}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="channel-modal__body">
          ${renderConfigForm({
            schema: params.schema,
            uiHints: params.uiHints,
            value: params.value,
            rawAvailable: params.rawAvailable,
            disabled: params.disabled,
            unsupportedPaths: params.unsupportedPaths,
            onPatch: params.onPatch,
            searchQuery: "",
            activeSection: "channels",
            activeSubsection: key,
            revealSensitive: false,
            isSensitivePathRevealed: params.isSensitivePathRevealed,
            onToggleSensitivePath: params.onToggleSensitivePath,
          })}
        </div>
      </div>
    </div>
  `;
}

// Channels section: a grid of tiles (name + tags) that open a focused per-channel
// config modal. Keeps the section scannable instead of stacking every channel's
// full form inline. The schema tags ("network"/"channels") are read directly off
// each property so tiles match the inline cards they replace.
function renderChannelTiles(
  sectionKey: string,
  node: JsonSchema,
  onOpen: (sectionKey: string, key: string) => void,
  hints: ConfigUiHints,
) {
  const props = node.properties ?? {};
  const entries = Object.entries(props).toSorted((a, b) => {
    const orderA = hintForPath([sectionKey, a[0]], hints)?.order ?? 0;
    const orderB = hintForPath([sectionKey, b[0]], hints)?.order ?? 0;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a[0].localeCompare(b[0]);
  });
  return html`
    <div class="channel-tiles cfg-fields">
      ${entries.map(([key, child]) => {
        const hint = hintForPath([sectionKey, key], hints);
        const label = hint?.label ?? child.title ?? humanize(key);
        const rawTags = child["x-tags"] ?? child.tags;
        const tags = Array.isArray(rawTags)
          ? rawTags.filter((tag): tag is string => typeof tag === "string")
          : [];
        return html`
          <button type="button" class="channel-tile" @click=${() => onOpen(sectionKey, key)}>
            <span class="channel-tile__body">
              <span class="channel-tile__title">${label}</span>
              ${tags.length
                ? html`<span class="channel-tile__tags"
                    >${tags.map((tag) => html`<span class="cfg-tag">${tag}</span>`)}</span
                  >`
                : nothing}
            </span>
            <span class="channel-tile__chevron">${icons.chevronRight}</span>
          </button>
        `;
      })}
    </div>
  `;
}

export function renderConfigForm(props: ConfigFormProps) {
  if (!props.schema) {
    return html` <div class="muted">${t("configForm.schemaUnavailable")}</div> `;
  }
  const schema = props.schema;
  const value = props.value ?? {};
  if (schemaType(schema) !== "object" || !schema.properties) {
    return html` <div class="callout danger">${t("configForm.unsupportedSchema")}</div> `;
  }
  const unsupported = new Set(props.unsupportedPaths ?? []);
  const properties = schema.properties;
  const searchQuery = props.searchQuery ?? "";
  const searchCriteria = parseConfigSearchQuery(searchQuery);
  const activeSection = props.activeSection;
  const activeSubsection = props.activeSubsection ?? null;

  const entries = Object.entries(properties).toSorted((a, b) => {
    const orderA = hintForPath([a[0]], props.uiHints)?.order ?? 50;
    const orderB = hintForPath([b[0]], props.uiHints)?.order ?? 50;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a[0].localeCompare(b[0]);
  });

  const filteredEntries = entries.filter(([key, node]) => {
    if (activeSection && key !== activeSection) {
      return false;
    }
    if (
      searchQuery &&
      !matchesSearch({
        key,
        schema: node,
        sectionValue: value[key],
        uiHints: props.uiHints,
        query: searchQuery,
      })
    ) {
      return false;
    }
    return true;
  });

  let subsectionContext: { sectionKey: string; subsectionKey: string; schema: JsonSchema } | null =
    null;
  if (activeSection && activeSubsection && filteredEntries.length === 1) {
    const sectionSchema = filteredEntries[0]?.[1];
    if (
      sectionSchema &&
      schemaType(sectionSchema) === "object" &&
      sectionSchema.properties &&
      sectionSchema.properties[activeSubsection]
    ) {
      subsectionContext = {
        sectionKey: activeSection,
        subsectionKey: activeSubsection,
        schema: sectionSchema.properties[activeSubsection],
      };
    }
  }

  if (filteredEntries.length === 0) {
    if (props.embedded && !searchQuery) {
      return nothing;
    }
    return renderSettingsPage(
      renderSettingsEmpty(
        searchQuery
          ? t("configForm.noSettingsMatch", { query: searchQuery })
          : t("configForm.noSettingsInSection"),
      ),
    );
  }

  const renderSection = (params: {
    id: string;
    sectionKey: string;
    label: string;
    description: string;
    node: JsonSchema;
    nodeValue: unknown;
    path: Array<string | number>;
  }) => html`
    <section class="settings-section" id=${params.id}>
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${params.label}</h2>
        ${props.sectionActions
          ? html`<div class="settings-section__actions">${props.sectionActions}</div>`
          : nothing}
      </div>
      ${params.description
        ? html`<p class="settings-section__desc">${params.description}</p>`
        : nothing}
      <div class="settings-group">
        ${props.onOpenChannelModal && params.sectionKey === "channels"
          ? renderChannelTiles(
              params.sectionKey,
              params.node,
              props.onOpenChannelModal,
              props.uiHints,
            )
          : renderNode({
              schema: params.node,
              value: params.nodeValue,
              path: params.path,
              hints: props.uiHints,
              rawAvailable: props.rawAvailable ?? true,
              unsupported,
              disabled: props.disabled ?? false,
              showLabel: false,
              searchCriteria,
              revealSensitive: props.revealSensitive ?? false,
              isSensitivePathRevealed: props.isSensitivePathRevealed,
              onToggleSensitivePath: props.onToggleSensitivePath,
              onPatch: props.onPatch,
            })}
      </div>
    </section>
  `;

  return renderSettingsPage(
    subsectionContext
      ? (() => {
          const { sectionKey, subsectionKey, schema: node } = subsectionContext;
          const hint = hintForPath([sectionKey, subsectionKey], props.uiHints);
          const label = hint?.label ?? node.title ?? humanize(subsectionKey);
          const description = hint?.help ?? node.description ?? "";
          const sectionValue = value[sectionKey];
          const scopedValue =
            sectionValue && typeof sectionValue === "object"
              ? (sectionValue as Record<string, unknown>)[subsectionKey]
              : undefined;
          return renderSection({
            id: `config-section-${sectionKey}-${subsectionKey}`,
            sectionKey,
            label,
            description,
            node,
            nodeValue: scopedValue,
            path: [sectionKey, subsectionKey],
          });
        })()
      : filteredEntries.map(([key, node]) => {
          const meta = SECTION_META[key] ?? {
            label: key.charAt(0).toUpperCase() + key.slice(1),
            description: node.description ?? "",
          };

          return renderSection({
            id: `config-section-${key}`,
            sectionKey: key,
            label: meta.label,
            description: meta.description,
            node,
            nodeValue: value[key],
            path: [key],
          });
        }),
  );
}
