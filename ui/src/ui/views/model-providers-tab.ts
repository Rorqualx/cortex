// Control UI view renders the Model Providers tab.
//
// Intentionally small. model-providers/view.ts is a 533-line surface with probe
// history, logout targets, cost windows and default-model editing behind 22
// callbacks; the reason people open this page is narrower — pick a provider,
// paste a key, check it works — and the schema editor under Agent Defaults was
// the only way to do that. This covers that path and leaves the richer view for
// whenever its full controller gets ported.
import { html, nothing, type TemplateResult } from "lit";
import type { ModelProvidersState } from "../controllers/model-providers.ts";

export type ModelProvidersTabProps = {
  state: ModelProvidersState;
  connected: boolean;
  canMutate: boolean;
  onSelectProvider: (provider: string) => void;
  onKeyDraftChange: (value: string) => void;
  onSave: () => void;
  onTest: (provider: string) => void;
  onRefresh: () => void;
};

function renderConfiguredCard(
  props: ModelProvidersTabProps,
  card: ModelProvidersState["cards"][number],
): TemplateResult {
  const probe = props.state.probe[card.id];
  const keyed = card.hasConfigApiKey || Boolean(card.apiKey);
  // Prefer the full-catalog count: a discovery-backed provider declares no
  // models in config, so card.modelCount is 0 even with a live catalog.
  const count = props.state.catalogCounts[card.id.toLowerCase()] ?? card.modelCount;
  return html`
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__title">${card.displayName}</span>
        <span class="settings-row__desc">
          ${count} ${count === 1 ? "model" : "models"} · ${keyed ? "API key set" : "no API key"}
          ${probe ? html` · <em>${probe.ok ? "✓" : "✕"} ${probe.text}</em>` : nothing}
        </span>
      </div>
      <div class="settings-row__control">
        <button
          type="button"
          class="settings-btn"
          ?disabled=${!props.connected || props.state.busy}
          @click=${() => props.onTest(card.id)}
        >
          Test
        </button>
      </div>
    </div>
  `;
}

export function renderModelProvidersTab(props: ModelProvidersTabProps): TemplateResult {
  const { state } = props;
  // Configured providers can be re-keyed too, so the dropdown lists both; an
  // unconfigured-only list cannot fix a wrong key, which is the common case.
  const configuredOptions = state.cards.map((card) => ({
    id: card.configKey ?? card.id,
    displayName: card.displayName,
  }));
  const options = [
    ...configuredOptions,
    ...state.options.filter((opt) => !configuredOptions.some((c) => c.id === opt.id)),
  ];
  const selected = state.selectedProvider;

  return html`
    <div class="settings-page">
      <div class="settings-section">
        <div class="settings-group">
          <div class="settings-row settings-row--stacked">
            <div class="settings-row__text">
              <span class="settings-row__title">Add or update a provider key</span>
              <span class="settings-row__desc">
                Pick a provider, paste its API key, and save. The key is written to
                <code>models.providers.&lt;id&gt;.apiKey</code>.
              </span>
            </div>
            <div class="settings-row__control mp-add">
              <select
                class="settings-select"
                .value=${selected}
                ?disabled=${!props.canMutate || state.busy}
                @change=${(e: Event) =>
                  props.onSelectProvider((e.target as HTMLSelectElement).value)}
              >
                <option value="" ?selected=${!selected}>Select a provider…</option>
                ${options.map(
                  (opt) => html`
                    <option value=${opt.id} ?selected=${opt.id === selected}>
                      ${opt.displayName}
                    </option>
                  `,
                )}
              </select>
              <input
                type="password"
                class="settings-input"
                placeholder="API key"
                autocomplete="off"
                .value=${state.keyDraft}
                ?disabled=${!props.canMutate || !selected || state.busy}
                @input=${(e: Event) => props.onKeyDraftChange((e.target as HTMLInputElement).value)}
              />
              <button
                type="button"
                class="settings-btn settings-btn--primary"
                ?disabled=${!props.canMutate || !selected || !state.keyDraft.trim() || state.busy}
                @click=${() => props.onSave()}
              >
                Save
              </button>
            </div>
          </div>
          ${state.notice
            ? html`<div class="settings-row">
                <div class="settings-row__text">
                  <span class="settings-row__desc">${state.notice}</span>
                </div>
              </div>`
            : nothing}
          ${state.error
            ? html`<div class="settings-row">
                <div class="settings-row__text">
                  <span class="cfg-field__error">${state.error}</span>
                </div>
              </div>`
            : nothing}
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section__header">
          <span class="settings-section__title">Configured providers</span>
          <button
            type="button"
            class="settings-btn"
            ?disabled=${!props.connected || state.loading}
            @click=${() => props.onRefresh()}
          >
            ${state.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        <div class="settings-group">
          ${state.cards.length === 0
            ? html`<div class="settings-row">
                <div class="settings-row__text">
                  <span class="settings-row__desc">
                    ${state.loading ? "Loading providers…" : "No providers configured yet."}
                  </span>
                </div>
              </div>`
            : state.cards.map((card) => renderConfiguredCard(props, card))}
        </div>
      </div>
    </div>
  `;
}
