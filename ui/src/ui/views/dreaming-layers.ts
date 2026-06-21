// Control UI "Layers" sub-tab for the Dreaming view: browses the seven ZenBrain
// memory layers, each rendered as human-readable markdown fetched from the
// `doctor.memory.l3Layers` gateway RPC. State is module-level (mirroring the
// rest of the Dreaming view) and re-renders are driven via host.onRequestUpdate.
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../../i18n/index.ts";
import type { DreamingL3Layer } from "../controllers/dreaming.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";

export type { DreamingL3Layer };

/** The host callbacks this section needs (a structural subset of DreamingProps). */
export type DreamingLayersHost = {
  onLoadL3LayerList: () => Promise<DreamingL3Layer[]>;
  onLoadL3LayerContent: (layerId: string) => Promise<string | null>;
  onRequestUpdate?: () => void;
};

let layers: DreamingL3Layer[] | null = null;
let layersLoading = false;
let activeLayerId: string | null = null;
let layerContent = "";
let layerContentLoading = false;
let layerError: string | null = null;
/** Guards against re-loading the same layer on every re-render. */
let loadedLayerId: string | null = null;
/** Bumped per load (and on reset) so a slower earlier load can't clobber a newer one. */
let loadGeneration = 0;

/**
 * Lazily load the layer list the first time the Layers tab is opened, then load
 * the first layer's content. Safe to call on every tab activation.
 */
export async function ensureDreamingLayers(host: DreamingLayersHost): Promise<void> {
  if (layers !== null || layersLoading) {
    return;
  }
  layersLoading = true;
  host.onRequestUpdate?.();
  try {
    layers = (await host.onLoadL3LayerList()) ?? [];
  } catch {
    layers = [];
    layerError = t("dreaming.layers.error");
  } finally {
    layersLoading = false;
  }
  if (layers.length > 0 && !activeLayerId) {
    await loadLayer(host, layers[0].id);
  }
  host.onRequestUpdate?.();
}

async function loadLayer(host: DreamingLayersHost, layerId: string): Promise<void> {
  const gen = ++loadGeneration;
  activeLayerId = layerId;
  loadedLayerId = layerId;
  layerContentLoading = true;
  layerError = null;
  host.onRequestUpdate?.();
  try {
    const content = (await host.onLoadL3LayerContent(layerId)) ?? "";
    if (gen !== loadGeneration) {
      return; // a newer load (or reset) superseded this one
    }
    layerContent = content;
  } catch {
    if (gen !== loadGeneration) {
      return;
    }
    layerContent = "";
    layerError = t("dreaming.layers.error");
  } finally {
    if (gen === loadGeneration) {
      layerContentLoading = false;
      host.onRequestUpdate?.();
    }
  }
}

/** Reset cached layers — call when the selected agent changes; cancels in-flight loads. */
export function resetDreamingLayers(): void {
  loadGeneration += 1;
  layers = null;
  activeLayerId = null;
  loadedLayerId = null;
  layerContent = "";
  layerError = null;
}

function renderLayerBody() {
  if (layerContentLoading && loadedLayerId !== null && layerContent.length === 0) {
    return html`<div class="dreams-layers__status">${t("dreaming.layers.loading")}</div>`;
  }
  if (layerError) {
    return html`<div class="dreams-layers__status dreams-layers__status--error">
      ${layerError}
    </div>`;
  }
  if (!layerContent || layerContent.trim().length === 0) {
    return html`<div class="dreams-layers__status">${t("dreaming.layers.empty")}</div>`;
  }
  return html`<div class="dreams-layers__markdown">
    ${unsafeHTML(toSanitizedMarkdownHtml(layerContent))}
  </div>`;
}

export function renderDreamingLayersSection(host: DreamingLayersHost) {
  if (layersLoading && layers === null) {
    return html`<section class="dreams-layers">
      <div class="dreams-layers__status">${t("dreaming.layers.loading")}</div>
    </section>`;
  }
  const available = layers ?? [];
  const activeLayer = available.find((layer) => layer.id === activeLayerId) ?? null;
  return html`
    <section class="dreams-layers">
      <p class="dreams-layers__explainer">${t("dreaming.layers.explainer")}</p>
      ${available.length === 0
        ? html`<div class="dreams-layers__status">${t("dreaming.layers.empty")}</div>`
        : html`
            <nav
              class="dreams-layers__tabs"
              role="tablist"
              aria-label=${t("dreaming.layers.tablistAria")}
            >
              ${available.map((layer) => {
                const selected = layer.id === activeLayerId;
                return html`<button
                  type="button"
                  role="tab"
                  class=${`dreams-layers__tab${selected ? " dreams-layers__tab--active" : ""}`}
                  aria-selected=${selected ? "true" : "false"}
                  title=${layer.description}
                  @click=${() => {
                    if (layer.id !== activeLayerId) {
                      void loadLayer(host, layer.id);
                    }
                  }}
                >
                  ${layer.label}
                </button>`;
              })}
            </nav>
            ${activeLayer
              ? html`<div class="dreams-layers__pane">
                  <header class="dreams-layers__pane-header">
                    <h3 class="dreams-layers__pane-title">${activeLayer.label}</h3>
                    <span class="dreams-layers__pane-desc">${activeLayer.description}</span>
                  </header>
                  ${renderLayerBody()}
                </div>`
              : nothing}
          `}
    </section>
  `;
}
