// Claude Connect plugin entrypoint: registers interactive Claude Code session tools.
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import type { AnyAgentTool } from "./api.js";
import {
  closeToolDefinition,
  createCloseTool,
  createOpenTool,
  createSendTool,
  openToolDefinition,
  sendToolDefinition,
  type ClaudeConnectFactoryContext,
} from "./src/tools.js";

// Activation is gated by the loader on `plugins.entries.claude-connect.enabled`;
// the tools only register once the plugin is enabled, so no extra config switch.
export default defineToolPlugin({
  id: "claude-connect",
  name: "Claude Connect",
  description:
    "Open interactive Claude Code sessions and delegate tasks or research (no Agent SDK).",
  configSchema: Type.Object(
    {
      defaultCwd: Type.Optional(Type.String()),
      binaryPath: Type.Optional(Type.String()),
      idleTurnTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  tools: (tool) => [
    tool({
      ...openToolDefinition,
      optional: true,
      factory: (ctx) =>
        createOpenTool(ctx as ClaudeConnectFactoryContext) as unknown as AnyAgentTool,
    }),
    tool({
      ...sendToolDefinition,
      optional: true,
      factory: (ctx) =>
        createSendTool(ctx as ClaudeConnectFactoryContext) as unknown as AnyAgentTool,
    }),
    tool({
      ...closeToolDefinition,
      optional: true,
      factory: (ctx) =>
        createCloseTool(ctx as ClaudeConnectFactoryContext) as unknown as AnyAgentTool,
    }),
  ],
});
