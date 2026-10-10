import type { z } from "zod";
import type { AgentSandboxConfig } from "./types.agents-shared.js";
import type { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

type SchemaAgentDefaultsConfig = NonNullable<z.input<typeof AgentDefaultsSchema>>;

export type AgentContextInjection = NonNullable<SchemaAgentDefaultsConfig["contextInjection"]>;
export type OptionalBootstrapFileName = NonNullable<
  SchemaAgentDefaultsConfig["skipOptionalBootstrapFiles"]
>[number];
export type EmbeddedAgentExecutionContract = NonNullable<
  NonNullable<SchemaAgentDefaultsConfig["embeddedAgent"]>["executionContract"]
>;
export type SubagentDelegationMode = NonNullable<
  NonNullable<SchemaAgentDefaultsConfig["subagents"]>["delegationMode"]
>;
export type ModelSelectionScope = NonNullable<SchemaAgentDefaultsConfig["modelSelectionScope"]>;
export type AgentThinkingLevel = NonNullable<SchemaAgentDefaultsConfig["thinkingDefault"]>;

export type AgentModelEntryConfig = NonNullable<SchemaAgentDefaultsConfig["models"]>[string];

export type AgentModelPolicyConfig = NonNullable<SchemaAgentDefaultsConfig["modelPolicy"]>;

export type AgentContextPruningConfig = NonNullable<SchemaAgentDefaultsConfig["contextPruning"]>;

export type AgentContextLimitsConfig = NonNullable<SchemaAgentDefaultsConfig["contextLimits"]>;

export type AgentDefaultsConfig = Omit<SchemaAgentDefaultsConfig, "sandbox"> & {
  /**
   * Fork: outer run loop retry iteration boundaries. Type-only (not in the strict
   * schema); read by the embedded runner's retry budget.
   */
  runRetries?: AgentRunRetriesConfig;
  sandbox?: AgentSandboxConfig;
};
export type AgentCompactionMode = NonNullable<AgentCompactionConfig["mode"]>;
export type AgentCompactionIdentifierPolicy = NonNullable<
  AgentCompactionConfig["identifierPolicy"]
>;
export type AgentRunRetriesConfig = {
  /** Base number of run retry iterations (default: 24). */
  base?: number;
  /** Additional run retry iterations per fallback profile (default: 8). */
  perProfile?: number;
  /** Minimum limit for run retry iterations (default: 32). */
  min?: number;
  /** Maximum limit for run retry iterations (default: 160). */
  max?: number;
};
export type AgentCompactionConfig = NonNullable<SchemaAgentDefaultsConfig["compaction"]>;
