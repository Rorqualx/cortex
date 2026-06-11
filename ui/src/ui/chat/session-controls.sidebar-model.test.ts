// Control UI tests cover agent dropdown labels and the sidebar new-session model.
import { describe, expect, it } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import {
  resolveChatAgentFilterOptions,
  resolveSidebarNewSessionAgentId,
  resolveSidebarNewSessionModel,
} from "./session-controls.ts";

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    sessionKey: "agent:main:main",
    agentsList: {
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "all",
      agents: [
        {
          id: "main",
          description: "General-purpose assistant. Default for everyday tasks.",
          model: { primary: "kimi/kimi-for-coding" },
        },
        {
          id: "yoren",
          name: "Yoren",
          description: "Speed demon. Use when wall-clock time matters most.",
          model: { primary: "deepseek/deepseek-v4-flash" },
        },
        { id: "podrick", name: "Podrick" },
      ],
    },
    sessionsResult: null,
    chatModelCatalog: [],
    chatModelOverrides: {},
    sidebarNewSessionModel: null,
    ...overrides,
  } as unknown as AppViewState;
}

describe("agent dropdown labels", () => {
  it("uses the agent description's first sentence as the use case, not the model", () => {
    const labels = new Map(
      resolveChatAgentFilterOptions(createState()).map((entry) => [entry.id, entry.label]),
    );
    expect(labels.get("main")).toBe("main (General-purpose assistant)");
    expect(labels.get("yoren")).toBe("Yoren (Speed demon)");
    for (const label of labels.values()) {
      expect(label).not.toMatch(/kimi-for-coding|deepseek-v4-flash/);
    }
  });

  it("falls back to the bare name when the agent has no description", () => {
    const labels = new Map(
      resolveChatAgentFilterOptions(createState()).map((entry) => [entry.id, entry.label]),
    );
    expect(labels.get("podrick")).toBe("Podrick");
  });
});

describe("resolveSidebarNewSessionAgentId", () => {
  it("follows the active session's agent when nothing is picked", () => {
    expect(resolveSidebarNewSessionAgentId(createState({ sessionKey: "agent:yoren:main" }))).toBe(
      "yoren",
    );
  });

  it("prefers an explicit sidebar pick over the active session", () => {
    const state = createState({
      sessionKey: "agent:yoren:main",
      sidebarNewSessionAgentId: "podrick",
    });
    expect(resolveSidebarNewSessionAgentId(state)).toBe("podrick");
  });

  it("falls back to the default agent for non-agent session keys", () => {
    expect(resolveSidebarNewSessionAgentId(createState({ sessionKey: "global" }))).toBe("main");
  });
});

describe("resolveSidebarNewSessionModel", () => {
  it("keys the model pick to the picked sidebar agent, not the active session", () => {
    const state = createState({
      sessionKey: "agent:yoren:main",
      sidebarNewSessionAgentId: "main",
      sidebarNewSessionModel: { agentId: "main", value: "zai/glm-5.1" },
    });
    expect(resolveSidebarNewSessionModel(state)).toBe("zai/glm-5.1");
  });

  it("returns the picked model while the same agent is active", () => {
    const state = createState({
      sidebarNewSessionModel: { agentId: "main", value: "zai/glm-5.1" },
    });
    expect(resolveSidebarNewSessionModel(state)).toBe("zai/glm-5.1");
  });

  it("drops the pick when the active agent changes so the new agent's preferred model applies", () => {
    const state = createState({
      sessionKey: "agent:yoren:main",
      sidebarNewSessionModel: { agentId: "main", value: "zai/glm-5.1" },
    });
    expect(resolveSidebarNewSessionModel(state)).toBe("");
  });

  it("returns empty when no pick exists", () => {
    expect(resolveSidebarNewSessionModel(createState())).toBe("");
  });
});
