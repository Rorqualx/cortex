// Type definitions for the v2 swarm pipeline. Pure types — this module
// imports nothing from sibling v2 files to avoid circular deps. All other
// v2 modules import from here.
//
// Architecture summary (see ~/.claude/plans/yes-but-lets-actually-tingly-pixel.md):
//
//   CEO (depth 0, ReAct loop) ─┬─ list_dir / read_file / glob / grep
//                              └─ spawn_subagents([...])
//                                   ↓
//                                   ├─ sub-agent #1 (depth 1) — full 10-tool ReAct + spawn_subagents
//                                   │    └─ spawn_subagents([...]) → depth 2 (no spawn)
//                                   ├─ sub-agent #2 (depth 1)
//                                   └─ ...     ← bounded by per-provider Semaphore

import type { ExploreToolName } from "./explore-tools.js";

// === ExtraTool: lets explore-loop accept tools from outside the built-in catalog ===

export interface ExtraToolCtx {
  /** Wall-clock signal the parent uses for cancellation. */
  signal: AbortSignal;
  /** Current iteration of the parent explore-loop calling this tool. */
  iteration: number;
  /** Wall-clock budget remaining (ms) for the parent. */
  remainingWallMs: number;
  /**
   * Slot management hooks. Used by `spawn_subagents` to release the parent's
   * semaphore slot before awaiting children (RAII release-during-spawn —
   * prevents depth-deadlock). No-ops when the parent doesn't hold a slot
   * (e.g. the CEO at depth 0). Threaded through ExploreInput.extraToolCtx.
   */
  releaseParentSlot?: () => void;
  reacquireParentSlot?: () => Promise<void>;
}

export interface ExtraToolResult {
  /** Tool output as it appears in the assistant's tool-result message. */
  content: string;
  /** Optional structured metadata for trace events; not shown to the model. */
  meta?: Record<string, unknown>;
}

export interface ExtraTool {
  /** Tool name. Must NOT collide with EXPLORE_TOOL_NAMES — checked at merge. */
  name: string;
  /** OpenAI-compat function-tool definition the LLM sees. */
  definition: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>; // JSON schema
    };
  };
  handler(args: unknown, ctx: ExtraToolCtx): Promise<ExtraToolResult>;
}

// === Subtask spec: what `spawn_subagents` accepts per element ===

export interface SubtaskV2Spec {
  objective: string;
  allowed_tools: ExploreToolName[];
  thinking: boolean;
  context_indices?: number[];
  /** Per-sub-agent iter cap. Honored within the swarm-level cap and floor. */
  max_iterations?: number;
}

// === Sub-agent result: what runOneSubAgentV2 returns ===

export interface SubagentV2Result {
  /** Globally unique index across the tree, assigned by SharedState. CEO is index 0. */
  index: number;
  /** Parent's index in the tree. null iff this is the CEO (depth 0). */
  parentIndex: number | null;
  /** 0 = CEO, 1-3 = sub-agents. */
  depth: number;
  ok: boolean;
  objective: string;
  allowedTools: string[];
  thinking: boolean;
  iterations: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  latencyMs: number;
  costUsd?: number;
  finishReason?: string;
  error?: string;
  /** Truncated to SUBAGENT_CONTENT_CAP_TO_PARENT chars before being passed back. */
  content: string;
  /** Indices of sub-agents this one spawned (recursion). */
  childIndices: number[];
}

// === Halt reasons + final result + stats ===

export type SwarmV2HaltReason =
  | "stop" // CEO emitted final synthesis successfully
  | "wall_cap" // root wall budget hit
  | "ceo_iter_cap" // CEO's explore-loop reached max_orchestration_rounds
  | "ceo_synthesis_empty" // CEO finished but produced empty content; fallback fired
  | "ceo_no_progress" // explore-loop's no-progress detector tripped on CEO
  | "spawn_budget_exhausted" // 100-agent ceiling hit; CEO synthesizes from what landed
  | "all_subagents_failed" // every spawn round produced 0 ok agents
  | "error"; // unrecoverable provider/network error

export interface SwarmV2Stats {
  totalAgents: number;
  okAgents: number;
  failedAgents: number;
  maxDepthReached: number;
  /** Distinct spawn_subagents invocations from the CEO. */
  spawnRounds: number;
  /** Agents that halted at iter_cap (any depth). */
  iterCapHits: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  costUsd?: number;
  latencyMs: number;
  /** Flat list, ordered by global index. CEO is index 0. */
  flatAgents: SubagentV2Result[];
}

export interface SwarmV2Result {
  content: string;
  haltReason: SwarmV2HaltReason;
  stats: SwarmV2Stats;
}

// === Top-level input ===

export interface SwarmV2Input {
  task: string;
  roots: string[];
  contextItems?: string[] | undefined;
  filePaths?: string[] | undefined;
  /** CEO + sub-agent model (sub-agent override via subagentModel). */
  model: string;
  /** Sub-agent model. When omitted, falls back to provider default. */
  subagentModel?: string | undefined;
  thinking: boolean;
  format: "text" | "markdown" | "json";
  maxOutputTokens: number;
  /** Hard cap on total agents in the tree (default 100, max 100). */
  maxTotalSubagents?: number | undefined;
  /** Recursion depth cap (default 3, max 3). 1 = no recursion (CEO + leaves). */
  maxDepth?: number | undefined;
  /** CEO's explore-loop iter cap (default 30, range 3-50). */
  maxOrchestrationRounds?: number | undefined;
  /** Per-sub-agent iter cap (default 30 for glm/deepseek, 18 for kimi; range 12-50). */
  maxIterationsPerSubagent?: number | undefined;
  /** Optional override of per-provider semaphore slot count. */
  subagentConcurrency?: number | undefined;
  allowedTools?: ExploreToolName[] | undefined;
  disallowedTools?: ExploreToolName[] | undefined;
  wallTimeMs?: number | undefined;
  maxBudgetUsd?: number | undefined;
}

// === Constants used across v2 modules ===

/**
 * Cap on each sub-agent's content when packaged into a tool-result string for
 * its parent. v1 truncates at 12000 chars before passing to the aggregator;
 * v2 tightens to 8000 because at the 100-agent ceiling, raw payloads from
 * all leaves could otherwise approach 1.2MB before any CEO synthesis turn.
 * The flatAgents array preserves the FULL pre-truncation content for trace
 * + final-stats consumers; only the inline tool-result render is truncated.
 */
export const SUBAGENT_CONTENT_CAP_TO_PARENT = 8000;

/** Hard ceiling on total agents in the tree. Schema enforces; runtime defends.
 *  Lifted 100→200 in 2026-05-10 parity push: the original 100 was Kimi Agent
 *  Swarm parity; with measured ~10 calls/agent on tool-call-dense scenarios,
 *  200 unlocks the headroom needed to clear the 1,500-tool-calls bar. The
 *  schema default stays at 100 so existing callers see no behavior change. */
export const MAX_TOTAL_SUBAGENTS_HARD = 200;

/** Hard ceiling on recursion depth. Schema enforces; tool-definition omission defends. */
export const MAX_DEPTH_HARD = 3;

/** Wall-budget fraction past which spawn_subagents is omitted from catalogs (forces synthesis). */
export const SPAWN_SOFT_GATE_FRACTION = 0.8;
