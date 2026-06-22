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
import type { WorkboardCard } from "../controllers/workboard.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { AgentsListResult, GatewayAgentRow, GatewaySessionRow } from "../types.ts";

// ── Crew (from CREW.md) ────────────────────────────────────────────

interface CrewAgent {
  id: string;
  name: string;
  emoji: string;
  role: string;
  neon: string; // neon body color
  shape?: number; // sprite shape override (generated agents); CREW uses SHAPE_MAP
}

const CREW: CrewAgent[] = [
  { id: "main", name: "Davos", emoji: "🧅", role: "Commander", neon: "#5a8a6e" },
  { id: "varys", name: "Varys", emoji: "🕸️", role: "Research & Intel", neon: "#8b6aae" },
  { id: "gendry", name: "Gendry", emoji: "🔨", role: "Code & Engineering", neon: "#4a8aaa" },
  { id: "yoren", name: "Yoren", emoji: "🪓", role: "Scout & Explorer", neon: "#5e9460" },
  { id: "samwell", name: "Samwell", emoji: "📚", role: "Scribe & Analysis", neon: "#a8834a" },
  { id: "stannis", name: "Stannis", emoji: "⚔️", role: "Review & QA", neon: "#aa5a52" },
  { id: "podrick", name: "Podrick", emoji: "🛡️", role: "Quartermaster", neon: "#5a9aaa" },
];

// ── Project offices ────────────────────────────────────────────────

export interface ProjectOffice {
  id: string;
  name: string;
  icon: string;
  agents: string[];
}

/** Derive projects dynamically from card labels like "project:OpenClaw" */
function deriveProjectsFromCards(cards: readonly WorkboardCard[]): ProjectOffice[] {
  const projectMap = new Map<string, { icon: string; agents: Set<string> }>();

  for (const card of cards) {
    for (const label of card.labels) {
      const match = label.match(/^project:([^:]+)(?::(.+))?$/i);
      if (!match) {
        continue;
      }
      const name = match[1]?.trim();
      const icon = match[2]?.trim() ?? "📁";
      if (!name) {
        continue;
      }

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
        projectMap.set(name, { icon, agents });
      }
    }
  }

  // Also include hardcoded defaults if no cards define them yet
  const defaults: ProjectOffice[] = [
    { id: "openclaw", name: "OpenClaw", icon: "🏰", agents: ["main", "gendry", "yoren"] },
    { id: "kaizoku", name: "Kaizoku", icon: "🏴‍☠️", agents: ["gendry", "varys"] },
    { id: "agentmcp", name: "AgentMCP", icon: "🤖", agents: ["gendry", "stannis"] },
    { id: "freezctl", name: "Freezctl", icon: "🌱", agents: ["podrick"] },
  ];

  const derived: ProjectOffice[] = [];
  for (const [name, meta] of projectMap) {
    derived.push({
      id: name.toLowerCase().replace(/\s+/g, "-"),
      name,
      icon: meta.icon,
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

function px(pixels: [number, number, string][]): string {
  return pixels.map(([x, y, c]) => `${x * PX}px ${y * PX}px 0 ${c}`).join(",");
}

// Each monster has a unique shape variant
// 0 = standard blob, 1 = tall & thin, 2 = wide & short, 3 = spiky, 4 = round, 5 = angular, 6 = tiny
const SHAPE_MAP: Record<string, number> = {
  main: 0,
  varys: 1,
  gendry: 2,
  yoren: 3,
  samwell: 4,
  stannis: 5,
  podrick: 6,
};

// Neon monster — varies shape per agent
function buildMonster(agent: CrewAgent, active: boolean, frame: number): string {
  const n = agent.neon;
  const dark = "#0a0a0a";
  const eye = "#ffffff";
  const pupil = active ? n : "#333";
  const shape = agent.shape ?? SHAPE_MAP[agent.id] ?? 0;

  let pixels: [number, number, string][];

  switch (shape) {
    case 1: // Varys — tall thin spider-like
      pixels = [
        [3, 0, n],
        [2, 1, n],
        [3, 1, n],
        [4, 1, n],
        [2, 2, n],
        [3, 2, eye],
        [4, 2, n],
        [2, 3, n],
        [3, 3, dark],
        [4, 3, n],
        [3, 4, n],
        [2, 5, n],
        [3, 5, n],
        [4, 5, n],
        [1, 6, n],
        [2, 6, n],
        [4, 6, n],
        [5, 6, n],
        [0, 7, n],
        [2, 7, n],
        [4, 7, n],
        [6, 7, n],
      ];
      break;
    case 2: // Gendry — wide stocky blacksmith
      pixels = [
        [2, 0, n],
        [4, 0, n],
        [1, 1, n],
        [2, 1, n],
        [3, 1, n],
        [4, 1, n],
        [5, 1, n],
        [0, 2, n],
        [1, 2, eye],
        [2, 2, n],
        [3, 2, n],
        [4, 2, n],
        [5, 2, eye],
        [6, 2, n],
        [0, 3, n],
        [1, 3, n],
        [2, 3, dark],
        [3, 3, n],
        [4, 3, dark],
        [5, 3, n],
        [6, 3, n],
        [0, 4, n],
        [1, 4, n],
        [2, 4, n],
        [3, 4, n],
        [4, 4, n],
        [5, 4, n],
        [6, 4, n],
        [1, 5, n],
        [5, 5, n],
      ];
      break;
    case 3: // Yoren — spiky wanderer
      pixels = [
        [1, 0, n],
        [3, 0, n],
        [5, 0, n],
        [2, 1, n],
        [3, 1, n],
        [4, 1, n],
        [1, 2, n],
        [2, 2, eye],
        [4, 2, eye],
        [5, 2, n],
        [0, 3, n],
        [1, 3, n],
        [2, 3, dark],
        [3, 3, n],
        [4, 3, dark],
        [5, 3, n],
        [6, 3, n],
        [1, 4, n],
        [2, 4, n],
        [3, 4, n],
        [4, 4, n],
        [5, 4, n],
        [1, 5, n],
        [3, 5, n],
        [5, 5, n],
        [0, 6, n],
        [6, 6, n],
      ];
      break;
    case 4: // Samwell — round bookish
      pixels = [
        [2, 0, n],
        [3, 0, n],
        [4, 0, n],
        [1, 1, n],
        [2, 1, n],
        [3, 1, n],
        [4, 1, n],
        [5, 1, n],
        [1, 2, n],
        [2, 2, eye],
        [3, 2, n],
        [4, 2, eye],
        [5, 2, n],
        [1, 3, n],
        [2, 3, n],
        [3, 3, dark],
        [4, 3, n],
        [5, 3, n],
        [0, 4, n],
        [1, 4, n],
        [2, 4, n],
        [3, 4, n],
        [4, 4, n],
        [5, 4, n],
        [6, 4, n],
        [0, 5, n],
        [1, 5, n],
        [2, 5, n],
        [3, 5, n],
        [4, 5, n],
        [5, 5, n],
        [6, 5, n],
        [2, 6, n],
        [4, 6, n],
      ];
      break;
    case 5: // Stannis — angular stern
      pixels = [
        [0, 0, n],
        [6, 0, n],
        [1, 1, n],
        [5, 1, n],
        [1, 2, n],
        [2, 2, eye],
        [4, 2, eye],
        [5, 2, n],
        [1, 3, n],
        [2, 3, n],
        [3, 3, dark],
        [4, 3, n],
        [5, 3, n],
        [0, 4, n],
        [1, 4, n],
        [2, 4, n],
        [3, 4, n],
        [4, 4, n],
        [5, 4, n],
        [6, 4, n],
        [0, 5, n],
        [2, 5, n],
        [4, 5, n],
        [6, 5, n],
        [0, 6, n],
        [6, 6, n],
      ];
      break;
    case 6: // Podrick — tiny squire
      pixels = [
        [2, 0, n],
        [4, 0, n],
        [2, 1, n],
        [3, 1, n],
        [4, 1, n],
        [2, 2, eye],
        [4, 2, eye],
        [2, 3, n],
        [3, 3, dark],
        [4, 3, n],
        [1, 4, n],
        [2, 4, n],
        [3, 4, n],
        [4, 4, n],
        [5, 4, n],
        [1, 5, n],
        [5, 5, n],
      ];
      break;
    default: // Davos — standard blob
      pixels = [
        [2, 0, n],
        [4, 0, n],
        [1, 1, n],
        [2, 1, n],
        [3, 1, n],
        [4, 1, n],
        [5, 1, n],
        [1, 2, n],
        [2, 2, eye],
        [3, 2, pupil],
        [4, 2, eye],
        [5, 2, n],
        [0, 3, n],
        [1, 3, n],
        [2, 3, dark],
        [3, 3, n],
        [4, 3, dark],
        [5, 3, n],
        [6, 3, n],
        [0, 4, n],
        [1, 4, n],
        [2, 4, n],
        [3, 4, n],
        [4, 4, n],
        [5, 4, n],
        [6, 4, n],
        [1, 5, n],
        [2, 5, n],
        [4, 5, n],
        [5, 5, n],
      ];
  }

  // Arms — always animate, active = fast flap, idle = slow wave
  if (frame === 0) {
    pixels.push([0, 2, n], [6, 2, n]); // arms up
  } else {
    pixels.push([0, 5, n], [6, 5, n]); // arms down
  }

  return px(pixels);
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
    return { agent, active: Boolean(isActive) };
  });
}

// ── Render ─────────────────────────────────────────────────────────

function renderMonsterBuddy(state: AgentState) {
  return html`
    <div class="mo-buddy" data-agent=${state.agent.id} data-active=${state.active}>
      <div class="mo-buddy__name">
        <span class="mo-buddy__emoji">${state.agent.emoji}</span>
        <span>${state.agent.name}</span>
      </div>
      <div class="mo-buddy__sprite-wrap">
        <div
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
        ></div>
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
          <span class="mo-cell__icon">${project.icon}</span>
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
                    ${a.agent.emoji}
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

/** Palette for generated (non-CREW) agent buddies; stable per agent id. */
const NEON_PALETTE = [
  "#5a8a6e",
  "#8b6aae",
  "#4a8aaa",
  "#5e9460",
  "#a8834a",
  "#aa5a52",
  "#5a9aaa",
  "#7a6acc",
  "#cc7a4a",
  "#4accaa",
  "#cc4a8a",
  "#8acc4a",
];

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Build a pixel buddy for a real agent: reuse CREW art by id, else generate. */
function buddyForAgent(row: GatewayAgentRow): CrewAgent {
  const crew = CREW.find((c) => c.id === row.id);
  if (crew) {
    return crew;
  }
  const h = hashId(row.id);
  return {
    id: row.id,
    name: row.name || row.id,
    emoji: row.identity?.emoji ?? "🤖",
    role: row.description ?? "",
    neon: NEON_PALETTE[h % NEON_PALETTE.length],
    shape: h % 7,
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
  draftEmoji: string;
  draftDescription: string;
  promptDraft: string;
  promptLoading: boolean;
  composing: boolean;
  savingPrompt: boolean;
  promptError: string | null;
  saving: boolean;
  error: string | null;
};

// Module-level singleton (mirrors dreaming-layers): the strip plugs into the
// app-render header with a single call and owns its own modal state.
const stripState: StripModalState = {
  mode: "none",
  profileAgentId: null,
  draftName: "",
  draftWorkspace: "",
  draftModel: "",
  draftEmoji: "",
  draftDescription: "",
  promptDraft: "",
  promptLoading: false,
  composing: false,
  savingPrompt: false,
  promptError: null,
  saving: false,
  error: null,
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
  stripState.draftEmoji = "";
  stripState.draftDescription = "";
  stripState.error = null;
  stripState.saving = false;
  resetPromptState();
  opts.requestUpdate?.();
}

function openProfile(opts: PixelAgentsStripOptions, id: string): void {
  stripState.mode = "profile";
  stripState.profileAgentId = id;
  resetPromptState();
  opts.requestUpdate?.();
  // Lazy-load the agent's SOUL.md prompt into the editor.
  void loadProfilePrompt(opts, id);
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
      ...(stripState.draftEmoji.trim() ? { emoji: stripState.draftEmoji.trim() } : {}),
      ...(stripState.draftDescription.trim()
        ? { description: stripState.draftDescription.trim() }
        : {}),
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
          ${stripState.composing ? "Generating…" : "✨ Generate from description"}
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
            ?disabled=${stripState.savingPrompt}
            @click=${() => void saveAgentPrompt(opts, params.agentId as string)}
          >
            ${stripState.savingPrompt ? "Saving…" : "Save prompt"}
          </button>`
        : nothing}
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
        ${renderTextField("Model (optional)", stripState.draftModel, "provider/model", (v) => {
          stripState.draftModel = v;
        })}
        ${renderTextField("Emoji (optional)", stripState.draftEmoji, "🤖", (v) => {
          stripState.draftEmoji = v;
        })}
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
          <h3>${buddy?.emoji ?? "🤖"} ${name}</h3>
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
          ${buddy?.role
            ? html`<div>
                <dt>Role</dt>
                <dd>${buddy.role}</dd>
              </div>`
            : nothing}
          ${row?.description
            ? html`<div>
                <dt>Description</dt>
                <dd>${row.description}</dd>
              </div>`
            : nothing}
          ${row?.workspace
            ? html`<div>
                <dt>Workspace</dt>
                <dd>${row.workspace}</dd>
              </div>`
            : nothing}
          ${row?.model?.primary
            ? html`<div>
                <dt>Model</dt>
                <dd>${row.model.primary}</dd>
              </div>`
            : nothing}
        </dl>
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
