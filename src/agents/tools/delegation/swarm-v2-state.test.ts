// Unit coverage for the shared-state budget/index bookkeeping and the
// per-provider concurrency resolution — the load-bearing recursion guards that
// previously had no tests.

import { afterEach, describe, expect, it } from "vitest";
import { resolveConcurrency } from "./swarm-v2-semaphore.js";
import { makeSharedState } from "./swarm-v2-state.js";
import type { SubagentV2Result } from "./swarm-v2-types.js";

function mk(maxTotalSubagents = 4, wallMs = 100_000) {
  return makeSharedState({ provider: "zai", wallMs, maxTotalSubagents, maxDepth: 3 });
}

function rec(overrides: Partial<SubagentV2Result>): SubagentV2Result {
  return {
    index: 1,
    parentIndex: 0,
    depth: 1,
    kind: "worker",
    ok: true,
    objective: "do work that is sufficiently long",
    allowedTools: ["read_file"],
    thinking: false,
    iterations: 1,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    content: "x",
    childIndices: [],
    ...overrides,
  };
}

describe("makeSharedState slot reservation", () => {
  it("hands out sequential indices then null at the cap", () => {
    const s = mk(4); // CEO holds index 0 => 3 sub-agent slots (1,2,3)
    expect(s.tryReserveAgentSlot()).toBe(1);
    expect(s.tryReserveAgentSlot()).toBe(2);
    expect(s.tryReserveAgentSlot()).toBe(3);
    expect(s.tryReserveAgentSlot()).toBeNull();
  });

  it("display accessors hide the CEO off-by-one", () => {
    const s = mk(4);
    expect(s.subagentCapacity()).toBe(3);
    expect(s.subagentCount()).toBe(0);
    expect(s.remainingSlots()).toBe(3);
    s.tryReserveAgentSlot();
    s.tryReserveAgentSlot();
    expect(s.subagentCount()).toBe(2);
    expect(s.remainingSlots()).toBe(1);
  });
});

describe("isSpawnDisabled", () => {
  it("is false with budget and time remaining", () => {
    const s = mk(4, 100_000);
    expect(s.isSpawnDisabled(0)).toBe(false);
    expect(s.isSpawnDisabled(40_000)).toBe(false);
  });

  it("trips past the 80% wall soft-gate", () => {
    const s = mk(4, 100_000);
    expect(s.isSpawnDisabled(85_000)).toBe(true);
  });

  it("trips once the agent budget is exhausted, regardless of time", () => {
    const s = mk(2); // capacity 1
    expect(s.isSpawnDisabled(0)).toBe(false);
    s.tryReserveAgentSlot(); // spawnedCount now == maxTotalSubagents
    expect(s.isSpawnDisabled(0)).toBe(true);
  });
});

describe("recordAgent", () => {
  it("appends and tracks the deepest recorded depth", () => {
    const s = mk();
    s.recordAgent(rec({ index: 1, depth: 1 }));
    s.recordAgent(rec({ index: 2, depth: 2 }));
    expect(s.flatAgents).toHaveLength(2);
    expect(s.maxDepthReached).toBe(2);
  });
});

describe("resolveConcurrency", () => {
  const envKeys = [
    "MCP_SWARM_V2_CONCURRENCY",
    "MCP_SWARM_V2_CONCURRENCY_ZAI",
    "MCP_SWARM_V2_CONCURRENCY_DEEPSEEK",
    "MCP_SWARM_V2_CONCURRENCY_KIMI",
  ];
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const k of envKeys) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  function clearEnv() {
    for (const k of envKeys) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  }

  it("uses per-provider defaults when no override or env is set", () => {
    clearEnv();
    expect(resolveConcurrency("zai")).toBe(8);
    expect(resolveConcurrency("deepseek")).toBe(4);
    expect(resolveConcurrency("kimi")).toBe(4);
  });

  it("honors an explicit override and clamps it to [1, 16]", () => {
    clearEnv();
    expect(resolveConcurrency("zai", 3)).toBe(3);
    expect(resolveConcurrency("zai", 99)).toBe(16);
    expect(resolveConcurrency("zai", 0)).toBe(1);
  });
});
