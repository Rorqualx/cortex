/**
 * Pixel office — neon monster terminal buddies.
 * Top row: all crew agents with flapping/stepping animation.
 * Bottom row: project office cells with open doors, showing who's inside.
 */

import { html, nothing } from "lit";
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

interface ProjectOffice {
  id: string;
  name: string;
  icon: string;
  agents: string[];
}

const PROJECTS: ProjectOffice[] = [
  { id: "openclaw", name: "OpenClaw", icon: "🏰", agents: ["main", "gendry", "yoren"] },
  { id: "kaizoku", name: "Kaizoku", icon: "🏴‍☠️", agents: ["gendry", "varys"] },
  { id: "agentmcp", name: "AgentMCP", icon: "🤖", agents: ["gendry", "stannis"] },
  { id: "freezctl", name: "Freezctl", icon: "🌱", agents: ["podrick"] },
];

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

function renderProjectCell(
  project: ProjectOffice,
  agentStates: AgentState[],
  sessions: GatewaySessionRow[],
) {
  const projAgents = project.agents
    .map((id) => agentStates.find((a) => a.agent.id === id))
    .filter(Boolean) as AgentState[];
  const anyActive = projAgents.some((a) => a.active);
  const activeNames = projAgents.filter((a) => a.active).map((a) => a.agent.emoji);

  return html`
    <div class="mo-cell ${anyActive ? "mo-cell--active" : ""}">
      <div class="mo-cell__door">
        <div class="mo-cell__header">
          <span class="mo-cell__icon">${project.icon}</span>
          <span class="mo-cell__name">${project.name}</span>
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

export function renderPixelOffice(
  _agentsList: AgentsListResult | null,
  sessions: GatewaySessionRow[],
): ReturnType<typeof html> {
  const agentStates = resolveAgentStates(sessions);

  return html`
    <div class="mo">
      <!-- Top row: all agents -->
      <div class="mo__agents">${agentStates.map((s) => renderMonsterBuddy(s))}</div>
      <!-- Bottom row: project offices -->
      <div class="mo__projects">
        ${PROJECTS.map((p) => renderProjectCell(p, agentStates, sessions))}
      </div>
    </div>
  `;
}
