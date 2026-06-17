// SwarmV2SharedState — single instance per runSwarmV2Loop invocation.
// Carries the wall controller, semaphore, agent counter, and the flat list
// of all agent results across the tree. Mutators are atomic (Node is
// single-threaded; no actual locks needed, just ordered access to fields).

import type { Provider } from "./providers/types.js";
import { Semaphore, resolveConcurrency } from "./swarm-v2-semaphore.js";
import type { SubagentV2Result } from "./swarm-v2-types.js";
import { MAX_TOTAL_SUBAGENTS_HARD, SPAWN_SOFT_GATE_FRACTION } from "./swarm-v2-types.js";

export interface SwarmV2SharedState {
  /** Provider, used for trace path + concurrency lookup. */
  readonly provider: Provider;
  /** Wall budget in ms (root). 0% = startedAt, 100% = startedAt + wallMs. */
  readonly wallMs: number;
  readonly startedAt: number;
  /** AbortController whose signal fires at wall_cap. Children share. */
  readonly wallController: AbortController;
  /** Semaphore bounding concurrent depth>=1 sub-agents. */
  readonly semaphore: Semaphore;
  /** Hard cap on tree size. Default MAX_TOTAL_SUBAGENTS_HARD. */
  readonly maxTotalSubagents: number;
  /** Recursion depth cap. Default MAX_DEPTH_HARD (3). */
  readonly maxDepth: number;

  /** Mutable: monotonic counter, also serves as the next agent's index. */
  spawnedCount: number;
  /** Mutable: max depth observed in any successful spawn (0 = CEO only). */
  maxDepthReached: number;
  /** Mutable: count of distinct spawn_subagents calls from the CEO. */
  spawnRoundsByCeo: number;
  /** Mutable: flat tree of all agent results, ordered by global index. */
  flatAgents: SubagentV2Result[];

  /** True iff acquiring a new agent slot would exceed the cap. Atomic-ish: read in same tick. */
  isSpawnDisabled(elapsedMs?: number): boolean;
  /**
   * Reserve an index for a new agent. Returns null if budget exhausted
   * (caller should produce a "spawn budget exhausted" error to the model).
   * Atomic in Node's single-threaded model — `spawnedCount` is incremented
   * before the function returns.
   */
  tryReserveAgentSlot(): number | null;
  /** Append a completed agent's result to flatAgents. Updates maxDepthReached. */
  recordAgent(result: SubagentV2Result): void;
}

export interface MakeSharedStateInput {
  provider: Provider;
  wallMs: number;
  maxTotalSubagents: number;
  maxDepth: number;
  subagentConcurrencyOverride?: number | undefined;
}

export function makeSharedState(input: MakeSharedStateInput): SwarmV2SharedState {
  const concurrency = resolveConcurrency(input.provider, input.subagentConcurrencyOverride);
  const wallController = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => wallController.abort(), input.wallMs).unref?.();

  const state: SwarmV2SharedState = {
    provider: input.provider,
    wallMs: input.wallMs,
    startedAt,
    wallController,
    semaphore: new Semaphore(concurrency),
    maxTotalSubagents: Math.min(input.maxTotalSubagents, MAX_TOTAL_SUBAGENTS_HARD),
    maxDepth: input.maxDepth,

    // Initialized to 1 because index 0 is reserved for the CEO. The CEO's
    // result is pushed via recordAgent() at end-of-loop; sub-agents call
    // tryReserveAgentSlot() which returns 1, 2, 3, ... With maxTotalSubagents=100,
    // the tree caps at 1 CEO + 99 sub-agents = 100 entries.
    spawnedCount: 1,
    maxDepthReached: 0,
    spawnRoundsByCeo: 0,
    flatAgents: [],

    isSpawnDisabled(elapsedMs?: number): boolean {
      // 80%-wall soft gate: when elapsed/wall > 0.80, spawn omitted from
      // catalogs. Forces the last 20% into synthesis. Pass elapsedMs for
      // wall-cap-aware decisions; without it, fall back to spawnedCount only.
      if (this.spawnedCount >= this.maxTotalSubagents) return true;
      if (typeof elapsedMs === "number") {
        if (elapsedMs / this.wallMs > SPAWN_SOFT_GATE_FRACTION) return true;
      }
      return false;
    },

    tryReserveAgentSlot(): number | null {
      // Race-safe in Node: increment-and-check happens in one synchronous block.
      if (this.spawnedCount >= this.maxTotalSubagents) return null;
      const idx = this.spawnedCount;
      this.spawnedCount = idx + 1;
      return idx;
    },

    recordAgent(result: SubagentV2Result): void {
      this.flatAgents.push(result);
      if (result.depth > this.maxDepthReached) {
        this.maxDepthReached = result.depth;
      }
    },
  };

  return state;
}
