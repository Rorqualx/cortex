// Control UI view renders agents panels overview screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ModelCatalogEntry,
} from "../types.ts";
import {
  buildModelOptions,
  normalizeModelValue,
  parseFallbackList,
  resolveAgentConfig,
  resolveAgentRuntimeLabel,
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
  crewMd: string;
  onConfigReload: () => void;
  onConfigSave: () => void;
  onModelChange: (agentId: string, modelId: string | null) => void;
  onModelFallbacksChange: (agentId: string, fallbacks: string[]) => void;
  onSelectPanel: (panel: AgentsPanel) => void;
  onCrewMdChange: (next: string) => void;
  agentsList: AgentsListResult | null;
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
    resolveModelFallbacks(config.entry?.model) ??
    resolveModelFallbacks(config.defaults?.model) ??
    (configForm ? null : resolveModelFallbacks(agentModel));
  const fallbackChips = modelFallbacks ?? [];
  const skillFilter = Array.isArray(config.entry?.skills) ? config.entry?.skills : null;
  const skillCount = skillFilter?.length ?? null;
  const disabled = !configForm || configLoading || configSaving;
  const thinkingDefault = agent.thinkingDefault ?? "-";

  const removeChip = (index: number) => {
    const next = fallbackChips.filter((_, i) => i !== index);
    onModelFallbacksChange(agent.id, next);
  };

  const handleChipKeydown = (e: KeyboardEvent) => {
    const input = e.target as HTMLInputElement;
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const parsed = parseFallbackList(input.value);
      if (parsed.length > 0) {
        onModelFallbacksChange(agent.id, [...fallbackChips, ...parsed]);
        input.value = "";
      }
    }
  };

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
          <div class="field">
            <span>Fallbacks</span>
            <div
              class="agent-chip-input"
              @click=${(e: Event) => {
                const container = e.currentTarget as HTMLElement;
                const input = container.querySelector("input");
                if (input) {
                  input.focus();
                }
              }}
            >
              ${fallbackChips.map(
                (chip, i) => html`
                  <span class="chip">
                    ${chip}
                    <button
                      type="button"
                      class="chip-remove"
                      ?disabled=${disabled}
                      @click=${() => removeChip(i)}
                    >
                      &times;
                    </button>
                  </span>
                `,
              )}
              <input
                ?disabled=${disabled}
                placeholder=${fallbackChips.length === 0 ? "provider/model" : ""}
                @keydown=${handleChipKeydown}
                @blur=${(e: Event) => {
                  const input = e.target as HTMLInputElement;
                  const parsed = parseFallbackList(input.value);
                  if (parsed.length > 0) {
                    onModelFallbacksChange(agent.id, [...fallbackChips, ...parsed]);
                    input.value = "";
                  }
                }}
              />
            </div>
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

      ${renderCrewSection(params)}
    </section>
  `;
}

function renderCrewSection(params: {
  crewMd: string;
  onCrewMdChange: (next: string) => void;
  agentsList: AgentsListResult | null;
  modelCatalog: ModelCatalogEntry[];
  onModelChange: (agentId: string, modelId: string | null) => void;
  configForm: Record<string, unknown> | null;
}) {
  const { crewMd, onCrewMdChange, agentsList, modelCatalog, onModelChange, configForm } = params;
  const allAgents = agentsList?.agents ?? [];
  const crewIds = crewMd
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const crewMembers = crewIds
    .map((id) => {
      const agent = allAgents.find((a) => a.id === id);
      return agent
        ? { id: agent.id, name: agent.identity?.name || agent.name || agent.id, model: agent.model }
        : null;
    })
    .filter(Boolean) as Array<{
    id: string;
    name: string;
    model?: { primary?: string; fallbacks?: string[] };
  }>;

  const availableAgents = allAgents.filter((a) => !crewIds.includes(a.id));
  const disabled = !configForm;

  return html`
    <div class="agent-model-select" style="margin-top: 24px;">
      <div
        style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;"
      >
        <div class="label">Crew.md</div>
        <button
          type="button"
          class="btn btn--sm"
          @click=${() => {
            const el = document.getElementById("crew-md-editor");
            if (el) {
              el.style.display = el.style.display === "none" ? "block" : "none";
            }
          }}
        >
          Edit
        </button>
      </div>

      <div id="crew-md-editor" style="display:none;margin-bottom:16px;">
        <textarea
          class="mono"
          style="width:100%;min-height:120px;padding:10px;border-radius:var(--radius-md);border:1px solid var(--border);background:var(--bg-elevated);color:var(--text);font-size:13px;resize:vertical;"
          .value=${crewMd}
          @input=${(e: Event) => onCrewMdChange((e.target as HTMLTextAreaElement).value)}
          placeholder="Enter agent IDs, one per line"
        ></textarea>
      </div>

      ${crewMembers.length === 0
        ? html`<div class="nav-item nav-item--muted" style="padding:8px 0;">
            No crew members defined.
          </div>`
        : html`
            <div class="agents-overview-grid">
              ${crewMembers.map(
                (member) => html`
                  <div class="agent-kv">
                    <div class="label">${member.name}</div>
                    <div>
                      <select
                        style="width:100%;"
                        .value=${member.model?.primary ?? ""}
                        ?disabled=${disabled}
                        @change=${(e: Event) =>
                          onModelChange(member.id, (e.target as HTMLSelectElement).value || null)}
                      >
                        <option value="">Inherit default</option>
                        ${buildModelOptions(
                          configForm,
                          member.model?.primary ?? undefined,
                          modelCatalog,
                          member.model?.primary ?? null,
                        )}
                      </select>
                    </div>
                  </div>
                `,
              )}
            </div>
          `}
      ${availableAgents.length > 0
        ? html`
            <div style="margin-top:16px;">
              <label class="field">
                <span>Add to crew</span>
                <select
                  ?disabled=${disabled}
                  @change=${(e: Event) => {
                    const id = (e.target as HTMLSelectElement).value;
                    if (id) {
                      const next = crewMd ? `${crewMd}\n${id}` : id;
                      onCrewMdChange(next);
                      (e.target as HTMLSelectElement).value = "";
                    }
                  }}
                >
                  <option value="">Select agent…</option>
                  ${availableAgents.map(
                    (a) =>
                      html`<option value=${a.id}>${a.identity?.name || a.name || a.id}</option>`,
                  )}
                </select>
              </label>
            </div>
          `
        : nothing}
    </div>
  `;
}
