// FIFO async semaphore for v2 sub-agent concurrency.
//
// Owned by SwarmV2SharedState (one per swarm invocation). Acquired on
// sub-agent entry, released on exit. The `spawn_subagents` handler uses
// release()/acquire() to release a parent's slot during the child wait
// (RAII release-during-spawn) so children don't deadlock waiting for slots
// held by parents that are themselves waiting.
//
// CEO (depth 0) does NOT acquire — it's outside the pool, since it never
// runs concurrently with its own children.

import type { Provider } from "./providers/types.js";

export class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isFinite(permits) || permits < 1) {
      throw new Error(`Semaphore permits must be >= 1, got ${permits}`);
    }
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    // FIFO wake — first waiter gets the next slot. Avoids LIFO starvation
    // where a CEO-spawn-spawn chain reacquires before depth-2 returns.
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

// Per-provider defaults. Calibrated against v1 matrix data:
//   - zai/glm: 8 — Coding Plan, no per-call rate concern, glm absorbs more parallelism
//   - deepseek: 4 — v4-flash is fast but provider has stricter rate limits at higher concurrency
//   - kimi: 4 — K2.6 inference latency dominates; >4 doesn't speed up the wall, just risks 429s
const DEFAULT_CONCURRENCY: Record<Provider, number> = {
  zai: 8,
  deepseek: 4,
  kimi: 4,
};

const ENV_PER_PROVIDER: Record<Provider, string> = {
  zai: "MCP_SWARM_V2_CONCURRENCY_ZAI",
  deepseek: "MCP_SWARM_V2_CONCURRENCY_DEEPSEEK",
  kimi: "MCP_SWARM_V2_CONCURRENCY_KIMI",
};
const ENV_UNIFORM = "MCP_SWARM_V2_CONCURRENCY";

const HARD_CEILING = 16;

/**
 * Resolve the concurrency permit count for a given provider.
 *   1. Per-call `override` (from SwarmV2Input.subagentConcurrency).
 *   2. Per-provider env var.
 *   3. Uniform env var.
 *   4. Per-provider default.
 *
 * All sources are clamped to [1, 16] regardless of how they were set.
 */
export function resolveConcurrency(provider: Provider, override?: number | undefined): number {
  let raw: number | undefined;

  if (typeof override === "number" && Number.isFinite(override)) {
    raw = override;
  } else {
    const perProv = process.env[ENV_PER_PROVIDER[provider]];
    if (perProv) {
      const n = Number(perProv);
      if (Number.isFinite(n)) raw = n;
    }
    if (raw === undefined) {
      const uniform = process.env[ENV_UNIFORM];
      if (uniform) {
        const n = Number(uniform);
        if (Number.isFinite(n)) raw = n;
      }
    }
    if (raw === undefined) raw = DEFAULT_CONCURRENCY[provider];
  }

  return Math.max(1, Math.min(HARD_CEILING, Math.floor(raw)));
}
