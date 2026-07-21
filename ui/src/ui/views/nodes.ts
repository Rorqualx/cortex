// Nodes page renders its screen content.
import { html, nothing } from "lit";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
} from "./settings-ui.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/nodes.css";
import { renderExecApprovals, resolveExecApprovalsState } from "./nodes-exec-approvals.ts";
import { renderNodesInventory } from "./view-inventory.ts";
import { resolveConfigAgents, resolveNodeTargets, type NodeTargetOption } from "./nodes-shared.ts";
export type { NodesProps } from "./nodes.types.ts";
import type { NodesProps } from "./nodes.types.ts";

export function renderNodes(props: NodesProps) {
  const bindingState = resolveBindingsState(props);
  const approvalsState = resolveExecApprovalsState(props);
  const summary = resolveNodesSummary(
    props,
    approvalsState.ready,
    approvalsState.defaults.security,
  );
  return renderSettingsPage(
    html`
      ${renderHero(summary)} ${renderNodesInventory(props)} ${renderExecApprovals(approvalsState)}
      ${renderBindings(bindingState)}
    `,
    { wide: true },
  );
}
// Fork delta: at-a-glance hero summary (nodes online / paired / pending / exec policy)
// rendered above the inventory sections. Styled by .node-hero in components.css.
type NodesSummary = {
  total: number;
  online: number;
  paired: number;
  pending: number;
  execMode: string;
};

function resolveNodesSummary(props: NodesProps, approvalsReady: boolean, execMode: string) {
  const list = props.devicesList ?? { pending: [], paired: [] };
  const summary: NodesSummary = {
    total: props.nodes.length,
    online: props.nodes.filter((n) => Boolean(n.connected)).length,
    paired: Array.isArray(list.paired) ? list.paired.length : 0,
    pending: Array.isArray(list.pending) ? list.pending.length : 0,
    execMode: approvalsReady ? execMode : "not loaded",
  };
  return summary;
}

function renderHero(summary: NodesSummary) {
  const stats: Array<{ value: string; label: string; alert?: boolean }> = [
    { value: `${summary.online}/${summary.total}`, label: "Nodes online" },
    { value: String(summary.paired), label: "Paired devices" },
    { value: String(summary.pending), label: "Pending approval", alert: summary.pending > 0 },
    { value: summary.execMode, label: "Default exec policy" },
  ];
  return html`
    <section class="card node-hero">
      <div class="node-hero__main">
        <span class="node-hero__icon" aria-hidden="true">🛰️</span>
        <div>
          <div class="card-title">Nodes &amp; devices</div>
          <div class="card-sub">
            The machines and devices your gateway can reach — what's online, what's trusted, where
            agents run commands, and what those commands are allowed to do.
          </div>
        </div>
      </div>
      <div class="node-stats">
        ${stats.map(
          (stat) => html`
            <div class="node-stat ${stat.alert ? "is-alert" : ""}">
              <span class="node-stat__value">${stat.value}</span>
              <span class="node-stat__label">${stat.label}</span>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}


type BindingAgent = {
  id: string;
  name: string | undefined;
  index: number;
  isDefault: boolean;
  binding: string | null;
};

type BindingNode = NodeTargetOption;

type BindingState = {
  ready: boolean;
  disabled: boolean;
  configDirty: boolean;
  configLoading: boolean;
  configSaving: boolean;
  defaultBinding?: string | null;
  agents: BindingAgent[];
  nodes: BindingNode[];
  onBindDefault: (nodeId: string | null) => void;
  onBindAgent: (agentIndex: number, nodeId: string | null) => void;
  onSave: () => void;
  onLoadConfig: () => void;
  formMode: "form" | "raw";
};

function resolveBindingsState(props: NodesProps): BindingState {
  const config = props.configForm;
  const nodes = resolveExecNodes(props.nodes);
  const { defaultBinding, agents } = resolveAgentBindings(config);
  const ready = Boolean(config);
  const disabled = props.configSaving || props.configFormMode === "raw";
  return {
    ready,
    disabled,
    configDirty: props.configDirty,
    configLoading: props.configLoading,
    configSaving: props.configSaving,
    defaultBinding,
    agents,
    nodes,
    onBindDefault: props.onBindDefault,
    onBindAgent: props.onBindAgent,
    onSave: props.onSaveBindings,
    onLoadConfig: props.onLoadConfig,
    formMode: props.configFormMode,
  };
}

function renderBindings(state: BindingState) {
  const supportsBinding = state.nodes.length > 0;
  const defaultValue = state.defaultBinding ?? "";
  const saveButton = html`
    <button class="btn" ?disabled=${state.disabled || !state.configDirty} @click=${state.onSave}>
      ${state.configSaving ? t("common.saving") : t("common.save")}
    </button>
  `;
  const rows = html`
    ${state.formMode === "raw"
      ? renderSettingsRow({ title: t("nodes.binding.formModeHint") })
      : nothing}
    ${!state.ready
      ? renderSettingsRow({
          title: t("nodes.binding.loadConfigHint"),
          control: html`
            <button class="btn" ?disabled=${state.configLoading} @click=${state.onLoadConfig}>
              ${state.configLoading ? t("common.loading") : t("common.loadConfig")}
            </button>
          `,
        })
      : html`
          ${renderSettingsRow({
            title: t("nodes.binding.defaultBinding"),
            description: supportsBinding
              ? t("nodes.binding.defaultBindingHint")
              : html`${t("nodes.binding.defaultBindingHint")} ${t("nodes.binding.noNodes")}`,
            control: html`
              <select
                class="settings-select"
                aria-label=${t("nodes.binding.node")}
                ?disabled=${state.disabled || !supportsBinding}
                @change=${(event: Event) => {
                  const target = event.target as HTMLSelectElement;
                  const value = target.value.trim();
                  state.onBindDefault(value ? value : null);
                }}
              >
                <option value="" ?selected=${defaultValue === ""}>
                  ${t("nodes.binding.anyNode")}
                </option>
                ${state.nodes.map(
                  (node) =>
                    html`<option value=${node.id} ?selected=${defaultValue === node.id}>
                      ${node.label}
                    </option>`,
                )}
              </select>
            `,
          })}
          ${state.agents.length === 0
            ? renderSettingsRow({ title: t("nodes.binding.noAgents") })
            : state.agents.map((agent) => renderAgentBinding(agent, state))}
        `}
  `;
  return renderSettingsSection(
    {
      title: t("nodes.binding.execNodeBinding"),
      description: t("nodes.binding.execNodeBindingSubtitle"),
      actions: saveButton,
    },
    rows,
  );
}

function renderAgentBinding(agent: BindingAgent, state: BindingState) {
  const bindingValue = agent.binding ?? "__default__";
  const label = agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id;
  const supportsBinding = state.nodes.length > 0;
  return renderSettingsRow({
    title: label,
    description: html`
      ${agent.isDefault ? t("nodes.binding.defaultAgent") : t("nodes.binding.agent")} ·
      ${bindingValue === "__default__"
        ? t("nodes.binding.usesDefault", {
            node: state.defaultBinding ?? t("nodes.binding.any"),
          })
        : t("nodes.binding.override", { node: agent.binding ?? "" })}
    `,
    control: html`
      <select
        class="settings-select"
        aria-label=${t("nodes.binding.binding")}
        ?disabled=${state.disabled || !supportsBinding}
        @change=${(event: Event) => {
          const target = event.target as HTMLSelectElement;
          const value = target.value.trim();
          state.onBindAgent(agent.index, value === "__default__" ? null : value);
        }}
      >
        <option value="__default__" ?selected=${bindingValue === "__default__"}>
          ${t("nodes.binding.useDefault")}
        </option>
        ${state.nodes.map(
          (node) =>
            html`<option value=${node.id} ?selected=${bindingValue === node.id}>
              ${node.label}
            </option>`,
        )}
      </select>
    `,
  });
}

function resolveExecNodes(nodes: Array<Record<string, unknown>>): BindingNode[] {
  return resolveNodeTargets(nodes, ["system.run"]);
}

function resolveAgentBindings(config: Record<string, unknown> | null): {
  defaultBinding?: string | null;
  agents: BindingAgent[];
} {
  const fallbackAgent: BindingAgent = {
    id: "main",
    name: undefined,
    index: 0,
    isDefault: true,
    binding: null,
  };
  if (!config || typeof config !== "object") {
    return { defaultBinding: null, agents: [fallbackAgent] };
  }
  const tools = (config.tools ?? {}) as Record<string, unknown>;
  const exec = (tools.exec ?? {}) as Record<string, unknown>;
  const defaultBinding =
    typeof exec.node === "string" && exec.node.trim() ? exec.node.trim() : null;

  const agentsNode = (config.agents ?? {}) as Record<string, unknown>;
  if (!Array.isArray(agentsNode.list) || agentsNode.list.length === 0) {
    return { defaultBinding, agents: [fallbackAgent] };
  }

  const agents = resolveConfigAgents(config).map((entry) => {
    const toolsEntry = (entry.record.tools ?? {}) as Record<string, unknown>;
    const execEntry = (toolsEntry.exec ?? {}) as Record<string, unknown>;
    const binding =
      typeof execEntry.node === "string" && execEntry.node.trim() ? execEntry.node.trim() : null;
    return {
      id: entry.id,
      name: entry.name,
      index: entry.index,
      isDefault: entry.isDefault,
      binding,
    };
  });

  if (agents.length === 0) {
    agents.push(fallbackAgent);
  }

  return { defaultBinding, agents };
}
