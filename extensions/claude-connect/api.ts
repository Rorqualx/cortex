// Claude Connect API module exposes the plugin public contract.
export {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
export type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "openclaw/plugin-sdk/agent-core";
