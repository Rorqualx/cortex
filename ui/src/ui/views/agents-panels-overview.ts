// Control UI view renders agents panels overview screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ModelCatalogEntry,
} from "../types.ts";
import {
  buildModelOptions,
  collectConfiguredModelOptions,
  type ConfiguredModelOption,
  normalizeModelValue,
  resolveAgentConfig,
  resolveAgentRuntimeLabel,
  resolveEffectiveModelFallbacks,
  resolveModelFallbacks,
  resolveModelLabel,
  resolveModelPrimary,
} from "./agents-utils.ts";
import type { AgentsPanel } from "./agents.types.ts";

export function renderAgentOverview(params: {
  agent: AgentsListResult["agents"][number];
  basePath: string;
  defaultId: string | null;
  configForm: Record<string, unknown> | null;
  agentFilesList: AgentsFilesListResult | null;
  agentIdentity: AgentIdentityResult | null;
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  modelCatalog: ModelCatalogEntry[];
  onConfigReload: () => void;
  onConfigSave: () => void;
  onModelChange: (agentId: string, modelId: string | null) => void;
  onModelFallbacksChange: (agentId: string, fallbacks: string[]) => void;
  onThinkingDefaultChange: (agentId: string, level: string | null) => void;
  onSelectPanel: (panel: AgentsPanel) => void;
}) {
  const {
    agent,
    configForm,
    agentFilesList,
    configLoading,
    configSaving,
    configDirty,
    onConfigReload,
    onConfigSave,
    onModelChange,
    onModelFallbacksChange,
    onThinkingDefaultChange,
    onSelectPanel,
  } = params;
  const isDefault = Boolean(params.defaultId && agent.id === params.defaultId);
  const config = resolveAgentConfig(configForm, agent.id);
  const agentModel = agent.model;
  const workspaceFromFiles =
    agentFilesList && agentFilesList.agentId === agent.id ? agentFilesList.workspace : null;
  const workspace =
    workspaceFromFiles ||
    config.entry?.workspace ||
    config.defaults?.workspace ||
    agent.workspace ||
    "default";
  const model = config.entry?.model
    ? resolveModelLabel(config.entry?.model)
    : config.defaults?.model
      ? resolveModelLabel(config.defaults?.model)
      : resolveModelLabel(agentModel);
  const runtime = resolveAgentRuntimeLabel(agent.agentRuntime);
  const defaultModel = resolveModelLabel(config.defaults?.model ?? agentModel);
  const entryPrimary = resolveModelPrimary(config.entry?.model);
  const defaultPrimary =
    resolveModelPrimary(config.defaults?.model) ||
    (defaultModel !== "-" ? normalizeModelValue(defaultModel) : null) ||
    (configForm ? null : resolveModelPrimary(agentModel));
  const effectivePrimary = entryPrimary ?? defaultPrimary ?? null;
  const selectedPrimary = isDefault ? effectivePrimary : entryPrimary;
  const modelFallbacks =
    resolveEffectiveModelFallbacks(config.entry?.model, config.defaults?.model) ??
    (configForm ? null : resolveModelFallbacks(agentModel));
  const fallbackChips = modelFallbacks ?? [];
  const skillFilter = Array.isArray(config.entry?.skills) ? config.entry?.skills : null;
  const skillCount = skillFilter?.length ?? null;
  const disabled = !configForm || configLoading || configSaving;
  const thinkingDefault = agent.thinkingDefault ?? "-";
  // Options are the model-constrained thinking levels the gateway already
  // resolved for this agent's model (empty when the model has no thinking
  // controls), so the dropdown only offers valid levels for the selected model.
  const thinkingLevelOptions = agent.thinkingLevels ?? [];
  const readConfiguredThinking = (source: unknown): string | null => {
    const value = (source as { thinkingDefault?: unknown } | null | undefined)?.thinkingDefault;
    return typeof value === "string" ? value : null;
  };
  const entryThinking = readConfiguredThinking(config.entry);
  const defaultThinking = readConfiguredThinking(config.defaults);
  // Mirror the primary-model select: the default agent shows its effective
  // value, other agents show only their own explicit override (else inherit).
  const selectedThinking = isDefault ? (entryThinking ?? defaultThinking) : entryThinking;

  const removeChip = (index: number) => {
    const next = fallbackChips.filter((_, i) => i !== index);
    onModelFallbacksChange(agent.id, next);
  };

  // Fallbacks are an ordered priority list; reordering swaps adjacent entries so
  // the numbered order the user sees is exactly what runtime tries in sequence.
  const moveChip = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= fallbackChips.length) {
      return;
    }
    const next = [...fallbackChips];
    [next[index], next[target]] = [next[target], next[index]];
    onModelFallbacksChange(agent.id, next);
  };

  const addFallback = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    const key = normalizeLowercaseStringOrEmpty(trimmed);
    if (fallbackChips.some((chip) => normalizeLowercaseStringOrEmpty(chip) === key)) {
      return;
    }
    onModelFallbacksChange(agent.id, [...fallbackChips, trimmed]);
  };

  // Offer every configured model except the ones already chosen and the primary
  // itself (a model never falls back to itself).
  const takenFallbackKeys = new Set(
    [...fallbackChips, effectivePrimary ?? ""]
      .map((value) => normalizeLowercaseStringOrEmpty(value))
      .filter(Boolean),
  );
  const fallbackAddOptions: ConfiguredModelOption[] = collectConfiguredModelOptions(
    configForm,
    params.modelCatalog,
  ).filter((option) => !takenFallbackKeys.has(normalizeLowercaseStringOrEmpty(option.value)));

  return html`
    <section class="card">
      <div class="card-title">Overview</div>
      <div class="card-sub">Workspace paths and identity metadata.</div>

      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">Workspace</div>
          <div>
            <button
              type="button"
              class="workspace-link mono"
              @click=${() => onSelectPanel("files")}
              title="Open Files tab"
            >
              ${workspace}
            </button>
          </div>
        </div>
        <div class="agent-kv">
          <div class="label">Primary Model</div>
          <div class="mono">${model}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Runtime</div>
          <div class="mono">${runtime}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("agents.context.thinkingDefault")}</div>
          <div class="mono">${thinkingDefault}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Skills Filter</div>
          <div>${skillFilter ? `${skillCount} selected` : "all skills"}</div>
        </div>
      </div>

      ${configDirty
        ? html`
            <div class="callout warn" style="margin-top: 16px">
              You have unsaved config changes.
            </div>
          `
        : nothing}

      <div class="agent-model-select" style="margin-top: 20px;">
        <div class="label">Model Selection</div>
        <div class="agent-model-fields">
          <label class="field">
            <span>Primary model${isDefault ? " (default)" : ""}</span>
            <select
              .value=${selectedPrimary ?? ""}
              ?disabled=${disabled}
              @change=${(e: Event) =>
                onModelChange(agent.id, (e.target as HTMLSelectElement).value || null)}
            >
              ${isDefault
                ? html` <option value="" ?selected=${!selectedPrimary}>Not set</option> `
                : html`
                    <option value="" ?selected=${!selectedPrimary}>
                      ${defaultPrimary ? `Inherit default (${defaultPrimary})` : "Inherit default"}
                    </option>
                  `}
              ${buildModelOptions(
                configForm,
                effectivePrimary ?? undefined,
                params.modelCatalog,
                selectedPrimary,
              )}
            </select>
          </label>
          <label class="field">
            <span>${t("agents.context.thinkingDefault")}${isDefault ? " (default)" : ""}</span>
            <select
              class="agent-thinking-default"
              .value=${selectedThinking ?? ""}
              ?disabled=${disabled}
              @change=${(e: Event) =>
                onThinkingDefaultChange(agent.id, (e.target as HTMLSelectElement).value || null)}
            >
              <option value="" ?selected=${!selectedThinking}>
                ${isDefault
                  ? "Not set"
                  : thinkingDefault !== "-"
                    ? `Inherit default (${thinkingDefault})`
                    : "Inherit default"}
              </option>
              ${thinkingLevelOptions.map(
                (level) => html`
                  <option value=${level.id} ?selected=${selectedThinking === level.id}>
                    ${level.label}
                  </option>
                `,
              )}
            </select>
          </label>
          <div class="field">
            <span>Fallbacks</span>
            <div class="agent-fallback-list">
              ${fallbackChips.length === 0
                ? html`<div class="agent-fallback-empty">No fallbacks. Add one below.</div>`
                : fallbackChips.map(
                    (chip, i) => html`
                      <div class="agent-fallback-row">
                        <span class="agent-fallback-index">${i + 1}</span>
                        <span class="agent-fallback-name mono">${chip}</span>
                        <div class="agent-fallback-actions">
                          <button
                            type="button"
                            class="agent-fallback-move"
                            title="Move up"
                            aria-label="Move fallback up"
                            ?disabled=${disabled || i === 0}
                            @click=${() => moveChip(i, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            class="agent-fallback-move"
                            title="Move down"
                            aria-label="Move fallback down"
                            ?disabled=${disabled || i === fallbackChips.length - 1}
                            @click=${() => moveChip(i, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            class="chip-remove"
                            title="Remove fallback"
                            aria-label="Remove fallback"
                            ?disabled=${disabled}
                            @click=${() => removeChip(i)}
                          >
                            &times;
                          </button>
                        </div>
                      </div>
                    `,
                  )}
            </div>
            <select
              class="agent-fallback-add"
              ?disabled=${disabled || fallbackAddOptions.length === 0}
              .value=${""}
              @change=${(e: Event) => {
                const select = e.target as HTMLSelectElement;
                addFallback(select.value);
                select.value = "";
              }}
            >
              <option value="" selected>
                ${fallbackAddOptions.length === 0 ? "No more configured models" : "Add fallback…"}
              </option>
              ${fallbackAddOptions.map(
                (option) => html`<option value=${option.value}>${option.label}</option>`,
              )}
            </select>
          </div>
        </div>
        <div class="agent-model-actions">
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${configLoading}
            @click=${onConfigReload}
          >
            ${t("common.reloadConfig")}
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${configSaving || !configDirty}
            @click=${onConfigSave}
          >
            ${configSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </section>
  `;
}
