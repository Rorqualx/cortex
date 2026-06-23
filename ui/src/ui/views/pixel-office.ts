/**
 * Pixel office — neon monster terminal buddies.
 * Top row: all crew agents with flapping/stepping animation.
 * Bottom row: project office cells with open doors, showing who's inside.
 *
 * Projects are derived dynamically from workboard card labels.
 * A card label matching /^project:(.+)/i creates a project office.
 * Inconspicuous gear icon provides add/edit/delete CRUD.
 */

import { html, nothing } from "lit";
import { agentAvatarUrl, isHonoredAvatarUrl } from "../avatar/agent-avatar.ts";
import {
  generateInvader,
  invaderBoxShadow,
  invaderColor,
  invaderDataUri,
} from "../avatar/invader.ts";
import { loadModels } from "../controllers/models.ts";
import type { WorkboardCard } from "../controllers/workboard.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { icons } from "../icons.ts";
import type {
  AgentsListResult,
  GatewayAgentRow,
  GatewaySessionRow,
  ModelCatalogEntry,
} from "../types.ts";
import { parseProjectLabel, projectIconName } from "./project-label.ts";

// ── Crew (from CREW.md) ────────────────────────────────────────────

interface CrewAgent {
  id: string;
  name: string;
  role: string;
  neon: string; // neon body color, reused for the initials avatar badge + sprite
  // Persisted/assigned avatar (data: or same-origin URL). When set, the office
  // renders this image instead of the auto-generated box-shadow invader.
  avatarUrl?: string;
}

const CREW: CrewAgent[] = [
  { id: "main", name: "Davos", role: "Commander", neon: "#5a8a6e" },
  { id: "varys", name: "Varys", role: "Research & Intel", neon: "#8b6aae" },
  { id: "gendry", name: "Gendry", role: "Code & Engineering", neon: "#4a8aaa" },
  { id: "yoren", name: "Yoren", role: "Scout & Explorer", neon: "#5e9460" },
  { id: "samwell", name: "Samwell", role: "Scribe & Analysis", neon: "#a8834a" },
  { id: "stannis", name: "Stannis", role: "Review & QA", neon: "#aa5a52" },
  { id: "podrick", name: "Podrick", role: "Quartermaster", neon: "#5a9aaa" },
];

// ── Project offices ────────────────────────────────────────────────

export interface ProjectOffice {
  id: string;
  name: string;
  icon: string;
  agents: string[];
  // Linked filesystem folder (3rd label segment: project:<name>:<icon>:<dir>).
  dir?: string;
}

/**
 * Agent avatar badge: the agent's assigned image if set, otherwise the
 * deterministic procedural invader. Tinted with the crew's neon color.
 */
function renderAgentAvatar(agent: CrewAgent, extraClass = "") {
  const cls = extraClass ? `mo-avatar ${extraClass}` : "mo-avatar";
  const src = agentAvatarUrl(agent.id, { avatarUrl: agent.avatarUrl });
  return html`<span class=${cls} style="--mo-avatar-color:${agent.neon};">
    <img class="mo-avatar__img" src=${src} alt=${agent.name} />
  </span>`;
}

/** Derive projects dynamically from card labels like "project:OpenClaw" */
function deriveProjectsFromCards(cards: readonly WorkboardCard[]): ProjectOffice[] {
  const projectMap = new Map<string, { icon: string; dir?: string; agents: Set<string> }>();

  for (const card of cards) {
    for (const label of card.labels) {
      const parsed = parseProjectLabel(label);
      if (!parsed) {
        continue;
      }
      // Icon stays a stored name (legacy emoji resolves at render time via projectIconName).
      const { name, icon, dir } = parsed;

      const existing = projectMap.get(name);
      if (existing) {
        if (card.agentId) {
          existing.agents.add(card.agentId);
        }
      } else {
        const agents = new Set<string>();
        if (card.agentId) {
          agents.add(card.agentId);
        }
        projectMap.set(name, { icon, dir, agents });
      }
    }
  }

  // Also include hardcoded defaults if no cards define them yet
  const defaults: ProjectOffice[] = [
    { id: "openclaw", name: "OpenClaw", icon: "folder", agents: ["main", "gendry", "yoren"] },
    { id: "kaizoku", name: "Kaizoku", icon: "bookmark", agents: ["gendry", "varys"] },
    { id: "agentmcp", name: "AgentMCP", icon: "bot", agents: ["gendry", "stannis"] },
    { id: "freezctl", name: "Freezctl", icon: "spark", agents: ["podrick"] },
  ];

  const derived: ProjectOffice[] = [];
  for (const [name, meta] of projectMap) {
    derived.push({
      id: name.toLowerCase().replace(/\s+/g, "-"),
      name,
      icon: meta.icon,
      dir: meta.dir,
      agents: [...meta.agents],
    });
  }

  // Merge defaults for any not already derived
  for (const def of defaults) {
    if (!derived.some((d) => d.name.toLowerCase() === def.name.toLowerCase())) {
      derived.push(def);
    }
  }

  return derived.toSorted((a, b) => a.name.localeCompare(b.name));
}

// ── Pixel sprite builder ───────────────────────────────────────────

const PX = 6;

// Procedural invader sprite, unique + deterministic per agent id. `frame` (0|1)
// drives the existing two-frame leg flap; `active` brightens the body slightly.
function buildMonster(agent: CrewAgent, active: boolean, frame: number): string {
  const sprite = generateInvader(agent.id);
  const color = active ? `color-mix(in srgb, ${agent.neon} 72%, #ffffff)` : agent.neon;
  return invaderBoxShadow(sprite, color, frame, PX);
}

// ── Session state ──────────────────────────────────────────────────

interface AgentState {
  agent: CrewAgent;
  active: boolean;
}

function resolveAgentStates(sessions: GatewaySessionRow[]): AgentState[] {
  return CREW.map((agent) => {
    const isActive =
      agent.id === "main"
        ? sessions.some((s) => s.kind === "direct" && s.hasActiveRun)
        : sessions.some((s) => s.hasActiveRun && s.key?.includes(agent.id));
    return { agent, active: isActive };
  });
}

// ── Render ─────────────────────────────────────────────────────────

function renderMonsterBuddy(state: AgentState) {
  return html`
    <div class="mo-buddy" data-agent=${state.agent.id} data-active=${state.active}>
      <div class="mo-buddy__name">
        ${renderAgentAvatar(state.agent, "mo-avatar--sm")}
        <span>${state.agent.name}</span>
      </div>
      <div class="mo-buddy__sprite-wrap">
        ${state.agent.avatarUrl
          ? html`<img
              class="mo-sprite-img ${state.active ? "mo-sprite-img--active" : ""}"
              src=${state.agent.avatarUrl}
              alt=${state.agent.name}
            />`
          : html`<div
                class="mo-sprite mo-sprite--base"
                style="width:${PX}px;height:${PX}px;box-shadow:${buildMonster(
                  state.agent,
                  state.active,
                  0,
                )};"
              ></div>
              <div
                class="mo-sprite mo-sprite--overlay ${state.active
                  ? "mo-sprite--fast"
                  : "mo-sprite--slow"}"
                style="width:${PX}px;height:${PX}px;box-shadow:${buildMonster(
                  state.agent,
                  state.active,
                  1,
                )};"
              ></div>`}
      </div>
    </div>
  `;
}

/** Inconspicuous gear icon for project CRUD */
const GEAR_ICON = html`<svg
  width="12"
  height="12"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <circle cx="12" cy="12" r="3" />
  <path
    d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
  />
</svg>`;

/** Plus icon for adding projects */
const PLUS_ICON = html`<svg
  width="14"
  height="14"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <line x1="12" y1="5" x2="12" y2="19" />
  <line x1="5" y1="12" x2="19" y2="12" />
</svg>`;

/** Close (X) icon for modals */
const CLOSE_ICON = html`<svg
  width="16"
  height="16"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <line x1="18" y1="6" x2="6" y2="18" />
  <line x1="6" y1="6" x2="18" y2="18" />
</svg>`;

/** Trash icon for deleting projects */
const TRASH_ICON = html`<svg
  width="12"
  height="12"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <polyline points="3 6 5 6 21 6" />
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
</svg>`;

function renderProjectCell(
  project: ProjectOffice,
  agentStates: AgentState[],
  _sessions: GatewaySessionRow[],
  options: {
    editable?: boolean;
    onEdit?: (project: ProjectOffice) => void;
    onDelete?: (project: ProjectOffice) => void;
  } = {},
) {
  const projAgents = project.agents
    .map((id) => agentStates.find((a) => a.agent.id === id))
    .filter(Boolean) as AgentState[];
  const anyActive = projAgents.some((a) => a.active);

  return html`
    <div class="mo-cell ${anyActive ? "mo-cell--active" : ""}">
      <div class="mo-cell__door">
        <div class="mo-cell__header">
          <span class="mo-cell__icon" aria-hidden="true"
            >${icons[projectIconName(project.icon)]}</span
          >
          <span class="mo-cell__name">${project.name}</span>
          ${options.editable
            ? html`
                <span class="mo-cell__actions">
                  <button
                    class="mo-cell__action-btn"
                    type="button"
                    title="Edit project"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      options.onEdit?.(project);
                    }}
                  >
                    ${GEAR_ICON}
                  </button>
                  <button
                    class="mo-cell__action-btn mo-cell__action-btn--danger"
                    type="button"
                    title="Remove project"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      options.onDelete?.(project);
                    }}
                  >
                    ${TRASH_ICON}
                  </button>
                </span>
              `
            : nothing}
        </div>
        <div class="mo-cell__agents">
          ${projAgents.length > 0
            ? projAgents.map(
                (a) => html`
                  <span
                    class="mo-cell__avatar ${a.active ? "mo-cell__avatar--active" : ""}"
                    title="${a.agent.name}${a.active ? " (working)" : ""}"
                  >
                    ${renderAgentAvatar(a.agent, "mo-avatar--sm")}
                  </span>
                `,
              )
            : html`<span class="mo-cell__empty">—</span>`}
        </div>
      </div>
    </div>
  `;
}

export interface PixelOfficeCallbacks {
  onAddProject?: () => void;
  onEditProject?: (project: ProjectOffice) => void;
  onDeleteProject?: (project: ProjectOffice) => void;
}

export function renderPixelOffice(
  _agentsList: AgentsListResult | null,
  sessions: GatewaySessionRow[],
  cards: readonly WorkboardCard[],
  callbacks?: PixelOfficeCallbacks,
): ReturnType<typeof html> {
  const agentStates = resolveAgentStates(sessions);
  const projects = deriveProjectsFromCards(cards);
  const editable = Boolean(callbacks?.onEditProject || callbacks?.onDeleteProject);

  return html`
    <div class="mo">
      <div class="mo__title">Projects</div>
      <!-- Project offices (agents now live in the compact header strip) -->
      <div class="mo__projects">
        ${projects.map((p) =>
          renderProjectCell(p, agentStates, sessions, {
            editable,
            onEdit: callbacks?.onEditProject,
            onDelete: callbacks?.onDeleteProject,
          }),
        )}
        ${callbacks?.onAddProject
          ? html`
              <button
                class="mo-cell mo-cell--add"
                type="button"
                title="Add project"
                aria-label="Add project"
                @click=${() => callbacks.onAddProject?.()}
              >
                ${PLUS_ICON}
              </button>
            `
          : nothing}
      </div>
    </div>
  `;
}

/**
 * Compact, horizontally-scrolling agent strip for the page header — moves the
 * crew avatars next to the Workboard title to save vertical space. New agents
 * populate this strip and overflow into the horizontal scroll.
 */
// ── Header agent strip: real agents + create / profile modals ──────

/** Persisted/assigned avatar URL from an agent row, if safe to render directly. */
function rowAvatarUrl(row: GatewayAgentRow): string | undefined {
  const candidate = row.identity?.avatarUrl ?? row.identity?.avatar;
  // Only honor a genuinely assigned photo; generated-invader SVGs and logo
  // placeholders are re-derived from the id so the office matches every surface.
  return candidate && isHonoredAvatarUrl(candidate) ? candidate : undefined;
}

/** Build a pixel buddy for a real agent: CREW name/role by id, else the row. */
function buddyForAgent(row: GatewayAgentRow): CrewAgent {
  const avatarUrl = rowAvatarUrl(row);
  const crew = CREW.find((c) => c.id === row.id);
  // Color is always invaderColor(id) so the office sprite matches the agent's
  // avatar everywhere else (chat, conversations, workboard) — one source of truth.
  return {
    id: row.id,
    name: crew?.name ?? row.name ?? row.id,
    role: crew?.role ?? row.description ?? "",
    neon: invaderColor(row.id),
    avatarUrl,
  };
}

function isAgentActive(id: string, sessions: GatewaySessionRow[]): boolean {
  return id === "main"
    ? sessions.some((s) => s.kind === "direct" && s.hasActiveRun)
    : sessions.some((s) => s.hasActiveRun && s.key?.includes(id));
}

function resolveStripAgents(
  agentsList: AgentsListResult | null | undefined,
  sessions: GatewaySessionRow[],
): AgentState[] {
  return (agentsList?.agents ?? []).map((row) => ({
    agent: buddyForAgent(row),
    active: isAgentActive(row.id, sessions),
  }));
}

export interface PixelAgentsStripOptions {
  agentsList?: AgentsListResult | null;
  client?: GatewayBrowserClient | null;
  connected?: boolean;
  canCreate?: boolean;
  defaultWorkspace?: string;
  requestUpdate?: () => void;
  onAgentsChanged?: () => void;
  onOpenAgent?: (id: string) => void;
}

type StripModalState = {
  mode: "none" | "create" | "profile";
  profileAgentId: string | null;
  draftName: string;
  draftWorkspace: string;
  draftModel: string;
  draftRole: string;
  draftEmoji: string;
  draftDescription: string;
  // Assigned avatar data-URI for the create modal ("" = auto/id-derived sprite).
  draftAvatar: string;
  promptDraft: string;
  promptLoading: boolean;
  composing: boolean;
  savingPrompt: boolean;
  promptError: string | null;
  saving: boolean;
  error: string | null;
  // Inline profile-edit drafts (Role/Description/Model), separate from the
  // create-modal drafts so an open profile never clobbers a half-typed create.
  profileRole: string;
  profileDescription: string;
  profileModel: string;
  // Assigned avatar data-URI for the open profile ("" = auto/id-derived sprite).
  profileAvatar: string;
  // Only persist avatar on save when the operator actually regenerated/reset it,
  // so an untouched file-path avatar is never clobbered into an inline data-URI.
  profileAvatarDirty: boolean;
  savingProfile: boolean;
  profileSaveError: string | null;
  // Model catalog for the inline Model picker; loaded lazily on profile open.
  models: ModelCatalogEntry[];
};

// Module-level singleton (mirrors dreaming-layers): the strip plugs into the
// app-render header with a single call and owns its own modal state.
const stripState: StripModalState = {
  mode: "none",
  profileAgentId: null,
  draftName: "",
  draftWorkspace: "",
  draftModel: "",
  draftRole: "",
  draftEmoji: "",
  draftDescription: "",
  draftAvatar: "",
  promptDraft: "",
  promptLoading: false,
  composing: false,
  savingPrompt: false,
  promptError: null,
  saving: false,
  error: null,
  profileRole: "",
  profileDescription: "",
  profileModel: "",
  profileAvatar: "",
  profileAvatarDirty: false,
  savingProfile: false,
  profileSaveError: null,
  models: [],
};

function resetPromptState(): void {
  stripState.promptDraft = "";
  stripState.promptLoading = false;
  stripState.composing = false;
  stripState.savingPrompt = false;
  stripState.promptError = null;
}

function closeStripModal(opts: PixelAgentsStripOptions): void {
  stripState.mode = "none";
  stripState.profileAgentId = null;
  stripState.error = null;
  stripState.saving = false;
  resetPromptState();
  opts.requestUpdate?.();
}

function openCreateAgent(opts: PixelAgentsStripOptions): void {
  stripState.mode = "create";
  stripState.draftName = "";
  stripState.draftWorkspace = opts.defaultWorkspace ?? "";
  stripState.draftModel = "";
  stripState.draftRole = "";
  stripState.draftEmoji = "";
  stripState.draftDescription = "";
  stripState.draftAvatar = ""; // default: new agent gets the auto id-derived sprite
  stripState.error = null;
  stripState.saving = false;
  resetPromptState();
  opts.requestUpdate?.();
  void loadProfileModels(opts);
}

function openProfile(opts: PixelAgentsStripOptions, id: string): void {
  stripState.mode = "profile";
  stripState.profileAgentId = id;
  resetPromptState();
  // Seed the inline-edit drafts from the live row so the fields open populated.
  // Role falls back to the cosmetic crew label when no persisted identity.role
  // exists yet, so the operator edits the value they actually see.
  const row = (opts.agentsList?.agents ?? []).find((a) => a.id === id);
  const buddy = row ? buddyForAgent(row) : CREW.find((c) => c.id === id);
  stripState.profileRole = row?.identity?.role ?? buddy?.role ?? "";
  stripState.profileDescription = row?.description ?? "";
  stripState.profileModel = row?.model?.primary ?? "";
  stripState.profileAvatar = row?.identity?.avatarUrl ?? "";
  stripState.profileAvatarDirty = false;
  stripState.savingProfile = false;
  stripState.profileSaveError = null;
  opts.requestUpdate?.();
  // Lazy-load the agent's SOUL.md prompt into the editor.
  void loadProfilePrompt(opts, id);
  void loadProfileModels(opts);
}

async function loadProfileModels(opts: PixelAgentsStripOptions): Promise<void> {
  if (!opts.client || !opts.connected || stripState.models.length > 0) {
    return;
  }
  try {
    const models = await loadModels(opts.client);
    // Both the profile and create modals use the picker.
    if (stripState.mode !== "none") {
      stripState.models = models;
      opts.requestUpdate?.();
    }
  } catch {
    // Non-fatal: the Model field falls back to the current value as the sole option.
  }
}

async function saveAgentProfile(opts: PixelAgentsStripOptions, id: string): Promise<void> {
  if (!opts.client || !opts.connected) {
    return;
  }
  stripState.savingProfile = true;
  stripState.profileSaveError = null;
  opts.requestUpdate?.();
  try {
    // Send only fields with a value; agents.update treats each as optional and
    // role persists as identity metadata, description on the agent entry.
    await opts.client.request("agents.update", {
      agentId: id,
      ...(stripState.profileModel.trim() ? { model: stripState.profileModel.trim() } : {}),
      ...(stripState.profileDescription.trim()
        ? { description: stripState.profileDescription.trim() }
        : {}),
      ...(stripState.profileRole.trim() ? { role: stripState.profileRole.trim() } : {}),
      ...(stripState.profileAvatarDirty ? { avatar: stripState.profileAvatar } : {}),
    });
    opts.onAgentsChanged?.();
  } catch (error) {
    stripState.profileSaveError = error instanceof Error ? error.message : String(error);
  } finally {
    stripState.savingProfile = false;
    opts.requestUpdate?.();
  }
}

async function loadProfilePrompt(opts: PixelAgentsStripOptions, id: string): Promise<void> {
  if (!opts.client || !opts.connected) {
    return;
  }
  stripState.promptLoading = true;
  stripState.promptError = null;
  opts.requestUpdate?.();
  try {
    const res = await opts.client.request<{ file?: { content?: string } }>("agents.files.get", {
      agentId: id,
      name: "SOUL.md",
    });
    // Only apply if this profile is still open (avoid clobbering after close/switch).
    if (stripState.mode === "profile" && stripState.profileAgentId === id) {
      stripState.promptDraft = typeof res.file?.content === "string" ? res.file.content : "";
    }
  } catch (error) {
    stripState.promptError = error instanceof Error ? error.message : String(error);
  } finally {
    stripState.promptLoading = false;
    opts.requestUpdate?.();
  }
}

async function composeAgentPrompt(
  opts: PixelAgentsStripOptions,
  brief: string,
  agentId?: string,
): Promise<void> {
  if (!opts.client || !opts.connected || !brief.trim()) {
    return;
  }
  stripState.composing = true;
  stripState.promptError = null;
  opts.requestUpdate?.();
  try {
    const res = await opts.client.request<{ prompt?: string }>("agents.composePrompt", {
      brief: brief.trim(),
      ...(agentId ? { agentId } : {}),
    });
    if (typeof res.prompt === "string" && res.prompt.trim()) {
      stripState.promptDraft = res.prompt;
    }
  } catch (error) {
    stripState.promptError = error instanceof Error ? error.message : String(error);
  } finally {
    stripState.composing = false;
    opts.requestUpdate?.();
  }
}

async function saveAgentPrompt(opts: PixelAgentsStripOptions, id: string): Promise<void> {
  if (!opts.client || !opts.connected) {
    return;
  }
  stripState.savingPrompt = true;
  stripState.promptError = null;
  opts.requestUpdate?.();
  try {
    await opts.client.request("agents.files.set", {
      agentId: id,
      name: "SOUL.md",
      content: stripState.promptDraft,
    });
  } catch (error) {
    stripState.promptError = error instanceof Error ? error.message : String(error);
  } finally {
    stripState.savingPrompt = false;
    opts.requestUpdate?.();
  }
}

async function submitCreateAgent(opts: PixelAgentsStripOptions): Promise<void> {
  const client = opts.client;
  const name = stripState.draftName.trim();
  const workspace = stripState.draftWorkspace.trim();
  if (!client || !opts.connected) {
    stripState.error = "Not connected.";
    opts.requestUpdate?.();
    return;
  }
  if (!name || !workspace) {
    stripState.error = "Name and workspace are required.";
    opts.requestUpdate?.();
    return;
  }
  stripState.saving = true;
  stripState.error = null;
  opts.requestUpdate?.();
  try {
    const res = await client.request<{ agentId?: string }>("agents.create", {
      name,
      workspace,
      ...(stripState.draftModel.trim() ? { model: stripState.draftModel.trim() } : {}),
      ...(stripState.draftDescription.trim()
        ? { description: stripState.draftDescription.trim() }
        : {}),
      ...(stripState.draftRole.trim() ? { role: stripState.draftRole.trim() } : {}),
      ...(stripState.draftAvatar ? { avatar: stripState.draftAvatar } : {}),
    });
    // Seed the composed prompt into the new agent's SOUL.md if one was written.
    const newId = typeof res.agentId === "string" ? res.agentId : undefined;
    if (newId && stripState.promptDraft.trim()) {
      try {
        await client.request("agents.files.set", {
          agentId: newId,
          name: "SOUL.md",
          content: stripState.promptDraft,
        });
      } catch {
        // Non-fatal: the agent exists; the prompt can be set later from its profile.
      }
    }
    closeStripModal(opts);
    opts.onAgentsChanged?.();
  } catch (error) {
    stripState.saving = false;
    stripState.error = error instanceof Error ? error.message : String(error);
    opts.requestUpdate?.();
  }
}

function renderTextField(
  label: string,
  value: string,
  placeholder: string,
  set: (next: string) => void,
) {
  return html`
    <label class="mo-field">
      <span>${label}</span>
      <input
        .value=${value}
        placeholder=${placeholder}
        @input=${(e: Event) => set((e.target as HTMLInputElement).value)}
      />
    </label>
  `;
}

function renderTextArea(
  label: string,
  value: string,
  placeholder: string,
  rows: number,
  set: (next: string) => void,
) {
  return html`
    <label class="mo-field">
      <span>${label}</span>
      <textarea
        rows=${rows}
        .value=${value}
        placeholder=${placeholder}
        @input=${(e: Event) => set((e.target as HTMLTextAreaElement).value)}
      ></textarea>
    </label>
  `;
}

/** Model picker for the profile editor, sourced from the gateway model catalog. */
// Shared model dropdown, sourced from the gateway model catalog. Keeps the
// current value as an option even if it isn't in the catalog (custom ref).
function renderModelSelect(current: string, onSelect: (value: string) => void, className = "") {
  const options = stripState.models;
  const currentInCatalog = options.some((m) => m.id === current);
  return html`
    <select
      class=${className}
      .value=${current}
      @change=${(e: Event) => onSelect((e.target as HTMLSelectElement).value)}
    >
      <option value="" ?selected=${!current}>(default)</option>
      ${current && !currentInCatalog
        ? html`<option value=${current} selected>${current}</option>`
        : nothing}
      ${options.map(
        (m) =>
          html`<option value=${m.id} ?selected=${m.id === current}>
            ${m.name}${m.provider ? ` · ${m.provider}` : ""}
          </option>`,
      )}
    </select>
  `;
}

function renderProfileModelSelect() {
  return renderModelSelect(
    stripState.profileModel,
    (v) => {
      stripState.profileModel = v;
    },
    "mo-profile__edit",
  );
}

/** Shared agent-prompt (SOUL.md) composer: Generate button + editable textarea. */
function renderPromptComposer(
  opts: PixelAgentsStripOptions,
  params: { brief: string; agentId?: string; showSave: boolean },
) {
  const canCompose = Boolean(
    opts.client && opts.connected && params.brief.trim() && !stripState.composing,
  );
  return html`
    <div class="mo-prompt">
      <div class="mo-prompt__head">
        <span>Agent prompt (SOUL.md)</span>
        <button
          class="mo-btn mo-btn--ghost"
          type="button"
          title="Generate a prompt from the description using the default model"
          ?disabled=${!canCompose}
          @click=${() => void composeAgentPrompt(opts, params.brief, params.agentId)}
        >
          ${stripState.composing
            ? "Generating…"
            : html`${icons.spark}<span>Generate from description</span>`}
        </button>
      </div>
      ${stripState.promptLoading
        ? html`<div class="mo-prompt__status">Loading prompt…</div>`
        : html`<textarea
            class="mo-prompt__text"
            rows="8"
            .value=${stripState.promptDraft}
            placeholder="Write the agent's SOUL.md prompt, or generate one from the description."
            @input=${(e: Event) => {
              stripState.promptDraft = (e.target as HTMLTextAreaElement).value;
            }}
          ></textarea>`}
      ${stripState.promptError
        ? html`<div class="mo-modal__error">${stripState.promptError}</div>`
        : nothing}
      ${params.showSave && params.agentId
        ? html`<button
            class="mo-btn mo-btn--primary mo-prompt__save"
            type="button"
            ?disabled=${stripState.savingPrompt || !stripState.promptDraft.trim()}
            @click=${() => void saveAgentPrompt(opts, params.agentId as string)}
          >
            ${stripState.savingPrompt ? "Saving…" : "Save prompt"}
          </button>`
        : nothing}
    </div>
  `;
}

// Generate a fresh assigned avatar: new random shape, given color, animated SVG.
function regenerateAvatar(color: string): string {
  const seed = `${Math.random()}`;
  return invaderDataUri(generateInvader(seed), color, { animate: true });
}

/**
 * Avatar preview + Regenerate/Reset controls. `onChange(value)` assigns; Reset
 * restores `autoValue` (the deterministic id-derived sprite for an existing
 * agent, or "" at create time so a new agent simply gets its auto sprite).
 */
function renderAvatarPicker(
  current: string,
  color: string,
  onChange: (value: string) => void,
  autoValue = "",
) {
  const isAuto = current === autoValue;
  return html`
    <div class="mo-avatar-picker">
      <span class="mo-avatar-picker__preview" style="--mo-avatar-color:${color};">
        ${current
          ? html`<img src=${current} alt="avatar preview" />`
          : html`<span class="mo-avatar-picker__auto">Auto</span>`}
      </span>
      <div class="mo-avatar-picker__actions">
        <button class="mo-btn" type="button" @click=${() => onChange(regenerateAvatar(color))}>
          Regenerate
        </button>
        ${isAuto
          ? nothing
          : html`<button class="mo-btn" type="button" @click=${() => onChange(autoValue)}>
              Reset to auto
            </button>`}
      </div>
    </div>
  `;
}

function renderCreateAgentModal(opts: PixelAgentsStripOptions) {
  if (stripState.mode !== "create") {
    return nothing;
  }
  return html`
    <div class="mo-modal" @click=${() => closeStripModal(opts)}>
      <div
        class="mo-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-label="New agent"
        @click=${(e: Event) => e.stopPropagation()}
      >
        <div class="mo-modal__head">
          <h3>New agent</h3>
          <button class="mo-modal__close" type="button" @click=${() => closeStripModal(opts)}>
            ${CLOSE_ICON}
          </button>
        </div>
        ${renderTextField("Name", stripState.draftName, "e.g. Tyrion", (v) => {
          stripState.draftName = v;
        })}
        ${renderTextField("Role", stripState.draftRole, "e.g. Commander", (v) => {
          stripState.draftRole = v;
        })}
        <label class="mo-field">
          <span>Avatar</span>
          ${renderAvatarPicker(
            stripState.draftAvatar,
            invaderColor(stripState.draftName || "new"),
            (v) => {
              stripState.draftAvatar = v;
              opts.requestUpdate?.();
            },
          )}
        </label>
        ${renderTextArea(
          "Description",
          stripState.draftDescription,
          "Brief: what this agent is for / when to use it.",
          2,
          (v) => {
            stripState.draftDescription = v;
          },
        )}
        ${renderTextField("Workspace", stripState.draftWorkspace, "/path/to/workspace", (v) => {
          stripState.draftWorkspace = v;
        })}
        <label class="mo-field">
          <span>Model</span>
          ${renderModelSelect(stripState.draftModel, (v) => {
            stripState.draftModel = v;
          })}
        </label>
        ${renderPromptComposer(opts, { brief: stripState.draftDescription, showSave: false })}
        ${stripState.error ? html`<div class="mo-modal__error">${stripState.error}</div>` : nothing}
        <div class="mo-modal__actions">
          <button class="mo-btn" type="button" @click=${() => closeStripModal(opts)}>Cancel</button>
          <button
            class="mo-btn mo-btn--primary"
            type="button"
            ?disabled=${stripState.saving}
            @click=${() => void submitCreateAgent(opts)}
          >
            ${stripState.saving ? "Creating…" : "Create agent"}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderAgentProfileModal(opts: PixelAgentsStripOptions, sessions: GatewaySessionRow[]) {
  if (stripState.mode !== "profile" || !stripState.profileAgentId) {
    return nothing;
  }
  const id = stripState.profileAgentId;
  const row = (opts.agentsList?.agents ?? []).find((a) => a.id === id);
  const buddy = row ? buddyForAgent(row) : CREW.find((c) => c.id === id);
  const active = isAgentActive(id, sessions);
  const name = buddy?.name ?? row?.name ?? id;
  return html`
    <div class="mo-modal" @click=${() => closeStripModal(opts)}>
      <div
        class="mo-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-label=${name}
        @click=${(e: Event) => e.stopPropagation()}
      >
        <div class="mo-modal__head">
          <h3>
            ${buddy ? renderAgentAvatar(buddy, "mo-avatar--sm") : icons.bot}
            <span>${name}</span>
          </h3>
          <button class="mo-modal__close" type="button" @click=${() => closeStripModal(opts)}>
            ${CLOSE_ICON}
          </button>
        </div>
        <dl class="mo-profile">
          <div>
            <dt>Status</dt>
            <dd>${active ? "Working" : "Idle"}</dd>
          </div>
          <div>
            <dt>Agent id</dt>
            <dd>${id}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>
              <input
                class="mo-profile__edit"
                .value=${stripState.profileRole}
                placeholder="e.g. Commander"
                @input=${(e: Event) => {
                  stripState.profileRole = (e.target as HTMLInputElement).value;
                }}
              />
            </dd>
          </div>
          <div>
            <dt>Description</dt>
            <dd>
              <textarea
                class="mo-profile__edit"
                rows="2"
                .value=${stripState.profileDescription}
                placeholder="What this agent is for"
                @input=${(e: Event) => {
                  stripState.profileDescription = (e.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
            </dd>
          </div>
          <div>
            <dt>Avatar</dt>
            <dd>
              ${renderAvatarPicker(
                stripState.profileAvatar,
                buddy?.neon ?? invaderColor(id),
                (v) => {
                  stripState.profileAvatar = v;
                  stripState.profileAvatarDirty = true;
                  opts.requestUpdate?.();
                },
                invaderDataUri(generateInvader(id), buddy?.neon ?? invaderColor(id), {
                  animate: true,
                }),
              )}
            </dd>
          </div>
          ${row?.workspace
            ? html`<div>
                <dt>Workspace</dt>
                <dd>${row.workspace}</dd>
              </div>`
            : nothing}
          <div>
            <dt>Model</dt>
            <dd>${renderProfileModelSelect()}</dd>
          </div>
        </dl>
        <div class="mo-profile__save-row">
          <button
            class="mo-btn mo-btn--primary"
            type="button"
            ?disabled=${stripState.savingProfile}
            @click=${() => void saveAgentProfile(opts, id)}
          >
            ${stripState.savingProfile ? "Saving…" : "Save changes"}
          </button>
          ${stripState.profileSaveError
            ? html`<span class="mo-modal__error">${stripState.profileSaveError}</span>`
            : nothing}
        </div>
        ${renderPromptComposer(opts, {
          brief: row?.description ?? buddy?.role ?? "",
          agentId: id,
          showSave: true,
        })}
        <div class="mo-modal__actions">
          ${opts.onOpenAgent
            ? html`<button
                class="mo-btn"
                type="button"
                @click=${() => {
                  const open = opts.onOpenAgent;
                  closeStripModal(opts);
                  open?.(id);
                }}
              >
                Manage in Agents tab
              </button>`
            : nothing}
          <button
            class="mo-btn mo-btn--primary"
            type="button"
            @click=${() => closeStripModal(opts)}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  `;
}

export function renderPixelAgentsStrip(
  sessions: GatewaySessionRow[],
  opts: PixelAgentsStripOptions = {},
): ReturnType<typeof html> {
  const agentStates = resolveStripAgents(opts.agentsList, sessions);
  return html`
    <div class="mo-strip">
      ${opts.canCreate
        ? html`<button
            class="mo-strip__add"
            type="button"
            title="New agent"
            aria-label="New agent"
            @click=${() => openCreateAgent(opts)}
          >
            ${PLUS_ICON}
          </button>`
        : nothing}
      ${agentStates.map(
        (s) => html`<button
          class="mo-buddy-btn"
          type="button"
          title=${`${s.agent.name} — view profile`}
          @click=${() => openProfile(opts, s.agent.id)}
        >
          ${renderMonsterBuddy(s)}
        </button>`,
      )}
    </div>
    ${renderCreateAgentModal(opts)} ${renderAgentProfileModal(opts, sessions)}
  `;
}
