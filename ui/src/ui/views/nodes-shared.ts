// Control UI view renders nodes shared screen content.
import { html, nothing, type TemplateResult } from "lit";
import { normalizeOptionalString } from "../string-coerce.ts";

export type NodeTargetOption = {
  id: string;
  label: string;
};

// Shared section header: an accent icon badge + title/subtitle on the left and
// an optional action (Save/Refresh) on the right, so every Nodes-page card reads
// the same way instead of each section hand-rolling its own header row.
export function nodeSectionHead(opts: {
  icon: string;
  title: string;
  sub: TemplateResult | string;
  action?: TemplateResult | typeof nothing;
}): TemplateResult {
  return html`
    <div class="node-head">
      <div class="node-head__lead">
        <span class="node-head__icon" aria-hidden="true">${opts.icon}</span>
        <div class="node-head__text">
          <div class="card-title">${opts.title}</div>
          <div class="card-sub">${opts.sub}</div>
        </div>
      </div>
      ${opts.action ?? nothing}
    </div>
  `;
}

// One-line "what this does" explainer rendered just under a section header.
export function nodeInfoNote(body: TemplateResult | string): TemplateResult {
  return html`<div class="callout info node-note">${body}</div>`;
}

export type DeviceTypeMetaInput = {
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
};

export type DeviceTypeBadge = { icon: string; label: string };

// Classify a paired/pending device into a friendly type badge from the metadata
// the pairing handshake records. platform (navigator.platform / process.platform)
// and clientId are the reliably populated signals; deviceFamily is best-effort.
const DEVICE_PLATFORM_BADGES: Array<{ test: RegExp; badge: DeviceTypeBadge }> = [
  { test: /iphone/, badge: { icon: "📱", label: "iPhone" } },
  { test: /ipad/, badge: { icon: "📱", label: "iPad" } },
  { test: /android/, badge: { icon: "📱", label: "Android" } },
  { test: /mac|darwin/, badge: { icon: "💻", label: "Mac" } },
  { test: /win/, badge: { icon: "🖥️", label: "Windows" } },
  { test: /linux/, badge: { icon: "🐧", label: "Linux" } },
];

export function describeDeviceType(meta: DeviceTypeMetaInput): DeviceTypeBadge {
  const haystack = `${meta.platform ?? ""} ${meta.deviceFamily ?? ""}`.toLowerCase();
  const matched = DEVICE_PLATFORM_BADGES.find((entry) => entry.test.test(haystack));
  if (matched) {
    return matched.badge;
  }
  const clientId = (meta.clientId ?? "").toLowerCase();
  if (clientId.includes("cli") || (meta.clientMode ?? "").toLowerCase() === "cli") {
    return { icon: "🔧", label: "CLI" };
  }
  const rawPlatform = meta.platform?.trim();
  if (rawPlatform) {
    return { icon: "🖥️", label: rawPlatform };
  }
  return { icon: "❔", label: "Unknown" };
}

// Friendly name for the paired client app, or null when unreported.
export function describeDeviceClient(clientId?: string): string | null {
  const value = clientId?.trim();
  if (!value) {
    return null;
  }
  if (value === "openclaw-control-ui") {
    return "Control UI";
  }
  if (value === "cli") {
    return "CLI";
  }
  return value;
}

export type ConfigAgentOption = {
  id: string;
  name?: string;
  isDefault: boolean;
  index: number;
  record: Record<string, unknown>;
};

export function resolveConfigAgents(config: Record<string, unknown> | null): ConfigAgentOption[] {
  const agentsNode = (config?.agents ?? {}) as Record<string, unknown>;
  const list = Array.isArray(agentsNode.list) ? agentsNode.list : [];
  const agents: ConfigAgentOption[] = [];

  list.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = normalizeOptionalString(record.id) ?? "";
    if (!id) {
      return;
    }
    const name = normalizeOptionalString(record.name);
    const isDefault = record.default === true;
    agents.push({ id, name, isDefault, index, record });
  });

  return agents;
}

export function resolveNodeTargets(
  nodes: Array<Record<string, unknown>>,
  requiredCommands: string[],
): NodeTargetOption[] {
  const required = new Set(requiredCommands);
  const list: NodeTargetOption[] = [];

  for (const node of nodes) {
    const commands = Array.isArray(node.commands) ? node.commands : [];
    const supports = commands.some((cmd) => required.has(String(cmd)));
    if (!supports) {
      continue;
    }

    const nodeId = normalizeOptionalString(node.nodeId) ?? "";
    if (!nodeId) {
      continue;
    }
    const displayName = normalizeOptionalString(node.displayName) ?? nodeId;
    list.push({
      id: nodeId,
      label: displayName === nodeId ? nodeId : `${displayName} · ${nodeId}`,
    });
  }

  list.sort((a, b) => a.label.localeCompare(b.label));
  return list;
}
