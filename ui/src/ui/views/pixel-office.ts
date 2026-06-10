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
import type { GatewaySessionRow } from "../types.ts";
import type { AgentsListResult } from "../types.ts";

// ── Crew (from CREW.md) ────────────────────────────────────────────

interface CrewAgent {
  id: string;
  name: string;
  emoji: string;
  role: string;
  neon: string; // neon body color
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
      if (!match) continue;
      const name = match[1]?.trim();
      const icon = match[2]?.trim() ?? "📁";
      if (!name) continue;

      const existing = projectMap.get(name);
      if (existing) {
        if (card.agentId) existing.agents.add(card.agentId);
      } else {
        const agents = new Set<string>();
        if (card.agentId) agents.add(card.agentId);
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

  return derived.sort((a, b) => a.name.localeCompare(b.name));
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
  const shape = SHAPE_MAP[agent.id] ?? 0;

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
  sessions: GatewaySessionRow[],
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
      <!-- Top row: all agents -->
      <div class="mo__agents">${agentStates.map((s) => renderMonsterBuddy(s))}</div>
      <!-- Bottom row: project offices -->
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
              <div class="mo-cell mo-cell--add">
                <button
                  class="mo-cell__add-btn"
                  type="button"
                  title="Add project"
                  @click=${() => callbacks.onAddProject?.()}
                >
                  ${PLUS_ICON}
                  <span>Add</span>
                </button>
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}
