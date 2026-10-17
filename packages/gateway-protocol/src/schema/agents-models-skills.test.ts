// Gateway Protocol tests cover agents models skills behavior.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AgentsListResultSchema,
  AgentsUpdateParamsSchema,
  ModelsAuthLogoutParamsSchema,
  ModelsAuthOrderSetParamsSchema,
  ModelsAuthStatusParamsSchema,
  ModelsListResultSchema,
  ModelsProbeParamsSchema,
  ModelsProbeResultSchema,
  SkillsDetailResultSchema,
  SkillsStatusParamsSchema,
  ToolsInvokeParamsSchema,
} from "./agents-models-skills.js";
import { ModelsListParamsSchema } from "./model-catalog.js";
import { GatewayAgentRuntimeSchema } from "./session-row.js";
import { ToolsEffectiveResultSchema } from "./tools-catalog.js";

/**
 * Schema regression tests for agent metadata, skills, and effective
 * tool catalogs. These payloads are UI-facing but also consumed by runtime
 * guards, so the fixtures exercise strictness at the public gateway boundary.
 */

function expectSchemaCases(
  schema: import("typebox").TSchema,
  expected: boolean,
  values: readonly unknown[],
) {
  for (const value of values) {
    expect(Value.Check(schema, value)).toBe(expected);
  }
}

const expectAccepted = (schema: import("typebox").TSchema, ...values: readonly unknown[]) =>
  expectSchemaCases(schema, true, values);
const expectRejected = (schema: import("typebox").TSchema, ...values: readonly unknown[]) =>
  expectSchemaCases(schema, false, values);

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
  it.each([undefined, "read-only", "guarded", "workspace", "full"])(
    "accepts optional configured permission label %s but rejects non-session modes",
    (defaultPermissionMode) => {
      const result = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main", ...(defaultPermissionMode ? { defaultPermissionMode } : {}) }],
      };
      expectAccepted(AgentsListResultSchema, result);
      expectRejected(AgentsListResultSchema, {
        ...result,
        agents: [{ id: "main", defaultPermissionMode: "allowlist" }],
      });
    },
  );

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

describe("AgentsUpdateParamsSchema", () => {
  it("distinguishes omitted, cleared, and invalid model values", () => {
    expectAccepted(AgentsUpdateParamsSchema, { agentId: "work" }, { agentId: "work", model: null });
    expectRejected(AgentsUpdateParamsSchema, { agentId: "work", model: "" });
  });
});

describe("SkillsStatusParamsSchema", () => {
  it("accepts an explicit refresh while retaining strict request validation", () => {
    expectAccepted(SkillsStatusParamsSchema, {}, { agentId: "main", refresh: true });
    expectRejected(SkillsStatusParamsSchema, { refresh: "true" }, { refresh: true, unknown: 1 });
  });
});

describe("ModelsListParamsSchema", () => {
  it("accepts the provider-config inventory view", () => {
    expectAccepted(
      ModelsListParamsSchema,
      { view: "provider-config" },
      {
        agentId: "writer",
        view: "all",
      },
      {
        agentId: "research",
        includeProviderCapabilities: true,
      },
      {
        preparedOnly: true,
      },
      {
        refresh: true,
        view: "all",
      },
    );
    expectRejected(
      ModelsListParamsSchema,
      { view: "provider-route" },
      { agentId: "" },
      { preparedOnly: true, refresh: true },
    );
  });
});

describe("ToolsEffectiveResultSchema", () => {
  it("accepts MCP identity and a true session-denial marker", () => {
    const result = {
      ...toolsEffectiveResult(),
      groups: [
        ...toolsEffectiveResult().groups,
        {
          id: "mcp",
          label: "MCP server tools",
          source: "mcp",
          tools: [
            {
              id: "notion__delete-page",
              label: "Delete page",
              description: "Delete a page",
              rawDescription: "Delete a page",
              source: "mcp",
              mcpServer: "notion",
              mcpToolName: "delete_page",
              deniedBySession: true,
            },
          ],
        },
      ],
    };

    expect(Value.Check(ToolsEffectiveResultSchema, result)).toBe(true);
    expect(
      Value.Check(ToolsEffectiveResultSchema, {
        ...result,
        groups: [
          ...result.groups.slice(0, -1),
          {
            ...result.groups.at(-1),
            tools: [{ ...result.groups.at(-1)?.tools[0], deniedBySession: false }],
          },
        ],
      }),
    ).toBe(false);
  });

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

  it("accepts server-scoped inventory notices", () => {
    const result = {
      ...toolsEffectiveResult(),
      notices: [
        {
          id: "mcp-not-yet-connected",
          severity: "info",
          message: "MCP tools are not available yet.",
          servers: ["github", "notion"],
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

describe("ToolsInvokeParamsSchema", () => {
  it("accepts only the operation-local direct-operator marker", () => {
    expect(
      Value.Check(ToolsInvokeParamsSchema, {
        name: "message",
        conversationReadOrigin: "direct-operator",
      }),
    ).toBe(true);
    expect(
      Value.Check(ToolsInvokeParamsSchema, {
        name: "message",
        conversationReadOrigin: "delegated",
      }),
    ).toBe(false);
  });
});

describe("SkillsDetailResultSchema", () => {
  it("accepts official ClawHub skill publisher metadata", () => {
    const result = {
      skill: {
        slug: "tao-setup-nvidia-gpu-host",
        displayName: "TAO Setup NVIDIA GPU Host",
        summary: "Prepare an NVIDIA GPU host for TAO workflows.",
        tags: { gpu: "GPU" },
        channel: "official",
        isOfficial: true,
        createdAt: 1_700_000_000,
        updatedAt: 1_700_010_000,
      },
      latestVersion: {
        version: "1.0.0",
        createdAt: 1_700_010_000,
      },
      owner: {
        handle: "nvidia",
        displayName: "NVIDIA",
        image: "https://example.test/nvidia.png",
        official: true,
        channel: "official",
        isOfficial: true,
      },
    };

    expect(Value.Check(SkillsDetailResultSchema, result)).toBe(true);
  });
});

describe("GatewayAgentRuntimeSchema devicePlacement", () => {
  it("accepts a valid device placement", () => {
    expect(
      Value.Check(GatewayAgentRuntimeSchema, {
        id: "codex",
        fallback: "openclaw",
        devicePlacement: {
          requiredNodeCommands: ["runtime.exec-server.v1"],
          consumesWorkerSlot: false,
        },
        source: "model",
      }),
    ).toBe(true);
  });

  it("rejects a device placement missing consumesWorkerSlot", () => {
    expect(
      Value.Check(GatewayAgentRuntimeSchema, {
        id: "codex",
        devicePlacement: { requiredNodeCommands: ["runtime.exec-server.v1"] },
        source: "model",
      }),
    ).toBe(false);
  });

  it("rejects oversized node commands", () => {
    expect(
      Value.Check(GatewayAgentRuntimeSchema, {
        id: "codex",
        devicePlacement: {
          requiredNodeCommands: ["x".repeat(129)],
          consumesWorkerSlot: false,
        },
        source: "model",
      }),
    ).toBe(false);
  });

  it("rejects more than 32 node commands", () => {
    expect(
      Value.Check(GatewayAgentRuntimeSchema, {
        id: "codex",
        devicePlacement: {
          requiredNodeCommands: Array.from({ length: 33 }, (_, index) => `runtime.${index}.v1`),
          consumesWorkerSlot: false,
        },
        source: "model",
      }),
    ).toBe(false);
  });
});

describe("ModelsListResultSchema", () => {
  it("accepts closed unavailability reasons and epoch-millisecond retry times", () => {
    const model = { id: "test-model", name: "Test Model", provider: "custom", available: false };
    for (const unavailableReason of ["missing-auth", "auth-failed", "cooldown"]) {
      expectAccepted(ModelsListResultSchema, { models: [{ ...model, unavailableReason }] });
    }
    expectAccepted(ModelsListResultSchema, {
      models: [{ ...model, unavailableReason: "cooldown", unavailableUntil: 2_000_000_000_000 }],
    });
    expectRejected(ModelsListResultSchema, {
      models: [{ ...model, unavailableReason: "unknown" }],
    });
    for (const unavailableUntil of [-1, 1.5, "2033-05-18T03:33:20.000Z"]) {
      expectRejected(ModelsListResultSchema, {
        models: [{ ...model, unavailableReason: "cooldown", unavailableUntil }],
      });
    }
  });
});

describe("ModelsAuthOrderSetParamsSchema", () => {
  it("requires a provider and rejects empty, null, or duplicate profile orders", () => {
    expectAccepted(
      ModelsAuthOrderSetParamsSchema,
      { provider: "openai", profileIds: ["openai:writer"] },
      { provider: "openai", agentId: "writer" },
    );
    expectRejected(
      ModelsAuthOrderSetParamsSchema,
      { provider: "openai", profileIds: [] },
      { provider: "openai", profileIds: null },
      { provider: "openai", profileIds: ["openai:writer", "openai:writer"] },
    );
  });
});
