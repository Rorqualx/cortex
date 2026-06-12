// Gateway Protocol tests cover agents models skills behavior.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { AgentsListResultSchema, ToolsEffectiveResultSchema } from "./agents-models-skills.js";

/**
 * Schema regression tests for agent metadata, skills, and effective
 * tool catalogs. These payloads are UI-facing but also consumed by runtime
 * guards, so the fixtures exercise strictness at the public gateway boundary.
 */

/** Minimal effective-tools result used by strict notice tests. */
function toolsEffectiveResult() {
  return {
    agentId: "main",
    profile: "full",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          {
            id: "exec",
            label: "Exec",
            description: "Run shell commands",
            rawDescription: "Run shell commands",
            source: "core",
          },
        ],
      },
    ],
  };
}

describe("AgentsListResultSchema", () => {
  it("accepts resolved per-agent thinking metadata", () => {
    const result = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        {
          id: "investment-master",
          name: "Investment Master",
          model: { primary: "deepseek/deepseek-v4-flash" },
          thinkingLevels: [
            { id: "off", label: "off" },
            { id: "xhigh", label: "xhigh" },
          ],
          thinkingOptions: ["off", "xhigh"],
          thinkingDefault: "xhigh",
        },
      ],
    };

    expect(Value.Check(AgentsListResultSchema, result)).toBe(true);
  });
});

describe("ToolsEffectiveResultSchema", () => {
  it("accepts runtime tool quarantine notices", () => {
    const result = {
      ...toolsEffectiveResult(),
      notices: [
        {
          id: "unsupported-tool-schema:fuzzplugin_move_angles",
          severity: "warning",
          message:
            'Tool "fuzzplugin_move_angles" from plugin "fuzzplugin" has an unsupported runtime input schema and was quarantined before model projection.',
        },
      ],
    };

    expect(Value.Check(ToolsEffectiveResultSchema, result)).toBe(true);
  });

  it("keeps tool quarantine notices strict", () => {
    const result = {
      ...toolsEffectiveResult(),
      notices: [
        {
          id: "unsupported-tool-schema:fuzzplugin_move_angles",
          severity: "warning",
          message: "Unsupported schema.",
          extra: true,
        },
      ],
    };

    expect(Value.Check(ToolsEffectiveResultSchema, result)).toBe(false);
  });
});
