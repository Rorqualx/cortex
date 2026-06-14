// Covers the agent session-override patch builder for model reassignment.
import { describe, expect, it } from "vitest";
import { buildAgentModelPatch } from "./reassign-agent.js";
import type { ReassignmentAction } from "./reassign-plan.js";

const agentBinding = {
  kind: "agent-model" as const,
  agentId: "podrick",
  sessionKey: "default",
  ref: { provider: "zai", modelId: "glm-4-long" },
};

describe("buildAgentModelPatch", () => {
  it("repoints the override at the qualified replacement on rewrite", () => {
    const action: ReassignmentAction = {
      binding: agentBinding,
      outcome: "rewrite",
      replacementModelId: "glm-5.1",
    };
    expect(buildAgentModelPatch(action)).toEqual({
      modelOverride: "zai/glm-5.1",
      providerOverride: "zai",
      modelOverrideSource: "auto",
    });
  });

  it("unsets the override on clear so the agent falls back to the default", () => {
    const action: ReassignmentAction = { binding: agentBinding, outcome: "clear" };
    expect(buildAgentModelPatch(action)).toEqual({
      modelOverride: undefined,
      providerOverride: undefined,
      modelOverrideSource: undefined,
    });
  });

  it("returns null for non-agent bindings", () => {
    const action: ReassignmentAction = {
      binding: { kind: "cron-model", jobId: "j1", ref: { provider: "zai", modelId: "glm-4-long" } },
      outcome: "clear",
    };
    expect(buildAgentModelPatch(action)).toBeNull();
  });
});
