import type { OpenClawConfig } from "./types.js";

export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
export const DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT = 5;
export const DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES = 60;
// Keep depth-1 subagents as leaves unless config explicitly opts into nesting.
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;

// Fast spawn defaults
export const DEFAULT_FASTSPAWN_ENABLED = false;
export const DEFAULT_FASTSPAWN_MAX_INLINE_WAIT_MS = 60_000;
export const DEFAULT_FASTSPAWN_SKIP_CAPABILITY_FILTERS = true;
export const DEFAULT_FASTSPAWN_SKIP_PLUGIN_LOADING = true;
export const DEFAULT_FASTSPAWN_REQUIRE_EXPLICIT_OPT_IN = true;

export function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_AGENT_MAX_CONCURRENT;
}

export function resolveSubagentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.subagents?.maxConcurrent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  return DEFAULT_SUBAGENT_MAX_CONCURRENT;
}

export type ResolvedFastSpawnConfig = {
  enabled: boolean;
  maxInlineWaitMs: number;
  skipCapabilityFilters: boolean;
  skipPluginLoading: boolean;
  requireExplicitOptIn: boolean;
};

export function resolveFastSpawnConfig(
  cfg?: OpenClawConfig,
  agentId?: string,
): ResolvedFastSpawnConfig {
  // Check agent-specific config first, then defaults
  const agentConfig = agentId ? cfg?.agents?.list?.find((a) => a.id === agentId) : undefined;
  const fastSpawnConfig =
    agentConfig?.subagents?.fastSpawn ?? cfg?.agents?.defaults?.subagents?.fastSpawn;

  return {
    enabled: fastSpawnConfig?.enabled ?? DEFAULT_FASTSPAWN_ENABLED,
    maxInlineWaitMs: fastSpawnConfig?.maxInlineWaitMs ?? DEFAULT_FASTSPAWN_MAX_INLINE_WAIT_MS,
    skipCapabilityFilters:
      fastSpawnConfig?.skipCapabilityFilters ?? DEFAULT_FASTSPAWN_SKIP_CAPABILITY_FILTERS,
    skipPluginLoading: fastSpawnConfig?.skipPluginLoading ?? DEFAULT_FASTSPAWN_SKIP_PLUGIN_LOADING,
    requireExplicitOptIn:
      fastSpawnConfig?.requireExplicitOptIn ?? DEFAULT_FASTSPAWN_REQUIRE_EXPLICIT_OPT_IN,
  };
}
