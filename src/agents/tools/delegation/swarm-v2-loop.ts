// Top-level v2 swarm loop. Builds SwarmV2SharedState, runs the CEO
// (itself a runExploreLoop with spawn_subagents as an extra-tool), and
// adjudicates the final answer.
//
// This is intentionally THIN. The heavy lifting lives in:
//   - explore-loop.ts (CEO + sub-agents are explore-loops)
//   - swarm-v2-spawn.ts (spawn_subagents tool factory + runOneSubAgentV2)
//   - swarm-v2-state.ts (semaphore + atomic slot reservation)

import { runExploreLoop, type ExploreInput, type ExploreResult } from "./explore-loop.js";
import type { LlmClient } from "./providers/types.js";
import { adjudicateHalt, deriveAgentOk } from "./swarm-v2-result.js";
import { makeSpawnSubagentsTool } from "./swarm-v2-spawn.js";
import { makeSharedState } from "./swarm-v2-state.js";
import { makeVerifyClaimsTool } from "./swarm-v2-verify.js";
import {
  MAX_DEPTH_HARD,
  MAX_TOTAL_SUBAGENTS_HARD,
  type SubagentV2Result,
  type SwarmV2Input,
  type SwarmV2Result,
  type SwarmV2Stats,
} from "./swarm-v2-types.js";
import { SYSTEM_PROMPTS } from "./system-prompts.js";

const DEFAULT_WALL_MS = 1_800_000; // 30 min — longer than v1's 20 min because v2 trees are bigger
const DEFAULT_MAX_ORCHESTRATION_ROUNDS = 30;
const CEO_BUDGET_TOKENS = 14000; // mirrors v1's kimi aggregator budget; CEO synthesizes detailed output

/**
 * The 4 fs-only tools the CEO uses to spot-check sub-agent claims. The CEO
 * is an orchestrator — it doesn't enumerate the codebase itself; that's
 * what sub-agents do. But it sometimes needs to verify a claim before
 * synthesizing.
 */
const CEO_FS_TOOLS = ["list_dir", "read_file", "glob", "grep"] as const;

export async function runSwarmV2Loop(
  client: LlmClient,
  input: SwarmV2Input,
): Promise<SwarmV2Result> {
  const startedAt = Date.now();
  const wallMs = input.wallTimeMs ?? DEFAULT_WALL_MS;
  const maxOrchestrationRounds = input.maxOrchestrationRounds ?? DEFAULT_MAX_ORCHESTRATION_ROUNDS;
  const maxTotalSubagents = Math.min(
    input.maxTotalSubagents ?? MAX_TOTAL_SUBAGENTS_HARD,
    MAX_TOTAL_SUBAGENTS_HARD,
  );
  const maxDepth = Math.min(input.maxDepth ?? MAX_DEPTH_HARD, MAX_DEPTH_HARD);

  const state = makeSharedState({
    provider: client.provider,
    wallMs,
    maxTotalSubagents,
    maxDepth,
    subagentConcurrencyOverride: input.subagentConcurrency,
  });

  // CEO's spawn tool. parentIndex=0, parentDepth=0. The CEO is outside the
  // semaphore (depth 0); the spawn tool's release/reacquire hooks are no-ops
  // from explore-loop because we don't pass extraToolCtx for the CEO.
  // Both the CEO's spawn and verify children push into the same index list.
  const ceoChildIndices: number[] = [];
  const spawnTool = makeSpawnSubagentsTool(0, 0, input, client, state, ceoChildIndices);
  const verifyTool = makeVerifyClaimsTool(0, 0, input, client, state, ceoChildIndices);

  const ceoInput: ExploreInput = {
    task: input.task,
    roots: input.roots,
    contextItems: input.contextItems,
    model: input.model,
    thinking: input.thinking,
    format: input.format,
    maxIterations: maxOrchestrationRounds,
    maxOutputTokens: CEO_BUDGET_TOKENS,
    // CEO sees only the 4 read-only fs tools + spawn_subagents. Web/bash/write
    // tools are not part of CEO's catalog — those belong to sub-agents who
    // need them. CEO is an orchestrator, not a worker.
    allowedTools: [...CEO_FS_TOOLS],
    wallTimeMs: wallMs, // CEO's loop wall == swarm wall
    wallSignal: state.wallController.signal,
    wallDeadlineMs: state.startedAt + state.wallMs, // shared-wall deadline for synthesis reserve

    maxBudgetUsd: input.maxBudgetUsd,
    extraTools: [spawnTool, verifyTool],
    // No extraToolCtx for the CEO — depth 0 is outside the semaphore.
    systemPromptAppendix: SYSTEM_PROMPTS.swarm_v2_ceo,
  };

  let ceoResult: ExploreResult | null = null;
  let runError: string | null = null;
  try {
    ceoResult = await runExploreLoop(client, ceoInput);
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
  }

  const ceoLatencyMs = Date.now() - startedAt;

  // Build the CEO's record (always at index 0 in flatAgents). ok/errorReason via
  // the shared deriveAgentOk so the CEO and sub-agents judge success identically.
  const ceoDerived = ceoResult ? deriveAgentOk(ceoResult.stats, ceoResult.content ?? "") : null;
  const ceoRecord: SubagentV2Result = ceoResult
    ? {
        index: 0,
        parentIndex: null,
        depth: 0,
        kind: "worker",
        ok: ceoDerived!.ok,
        objective: input.task,
        allowedTools: [...CEO_FS_TOOLS, "spawn_subagents"],
        thinking: input.thinking,
        iterations: ceoResult.stats.iterations,
        toolCalls: ceoResult.stats.toolCalls,
        inputTokens: ceoResult.stats.inputTokens,
        outputTokens: ceoResult.stats.outputTokens,
        ...(ceoResult.stats.cacheHitTokens !== undefined
          ? { cacheHitTokens: ceoResult.stats.cacheHitTokens }
          : {}),
        latencyMs: ceoLatencyMs,
        ...(ceoResult.stats.costUsd !== undefined ? { costUsd: ceoResult.stats.costUsd } : {}),
        ...(ceoResult.stats.stopReason ? { finishReason: ceoResult.stats.stopReason } : {}),
        ...(ceoDerived!.errorReason ? { error: ceoDerived!.errorReason } : {}),
        content: ceoResult.content ?? "",
        childIndices: ceoChildIndices,
      }
    : {
        index: 0,
        parentIndex: null,
        depth: 0,
        kind: "worker",
        ok: false,
        objective: input.task,
        allowedTools: [...CEO_FS_TOOLS, "spawn_subagents"],
        thinking: input.thinking,
        iterations: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: ceoLatencyMs,
        error: runError ?? "CEO explore-loop returned null",
        content: "",
        childIndices: ceoChildIndices,
      };
  state.recordAgent(ceoRecord);

  // === Adjudicate final answer ===
  // Precedence + fallback logic lives in adjudicateHalt (swarm-v2-result) so it
  // can be unit-tested without a live provider. flatAgents already includes the
  // CEO at index 0; adjudicateHalt scopes sub-agent checks to depth>0.
  const { haltReason, content: finalContent } = adjudicateHalt({
    task: input.task,
    ceoResult,
    runError,
    wallAborted: state.wallController.signal.aborted,
    flatAgents: state.flatAgents,
    spawnedCount: state.spawnedCount,
    maxTotalSubagents,
  });

  // Sort flatAgents by index for stable ordering across the tree (CEO at 0).
  state.flatAgents.sort((a, b) => a.index - b.index);

  // === Assemble stats ===

  const iterCapHits = state.flatAgents.filter(
    (a) => a.error?.includes("halt=iter_cap") || a.finishReason === "iter_cap",
  ).length;

  const totalInputTokens = state.flatAgents.reduce((s, a) => s + a.inputTokens, 0);
  const totalOutputTokens = state.flatAgents.reduce((s, a) => s + a.outputTokens, 0);
  const totalCacheHits = state.flatAgents.reduce((s, a) => s + (a.cacheHitTokens ?? 0), 0);
  const totalCost = state.flatAgents.reduce((s, a) => s + (a.costUsd ?? 0), 0);

  const stats: SwarmV2Stats = {
    totalAgents: state.flatAgents.length,
    okAgents: state.flatAgents.filter((a) => a.ok).length,
    failedAgents: state.flatAgents.filter((a) => !a.ok).length,
    maxDepthReached: state.maxDepthReached,
    spawnRounds: state.spawnRoundsByCeo,
    iterCapHits,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    ...(totalCacheHits > 0 ? { cacheHitTokens: totalCacheHits } : {}),
    ...(totalCost > 0 ? { costUsd: totalCost } : {}),
    ...(state.verifiedClaims > 0
      ? {
          verification: {
            claims: state.verifiedClaims,
            survived: state.survivedClaims,
            refuted: state.refutedClaims,
            verifierAgents: state.flatAgents.filter((a) => a.kind === "verifier").length,
          },
        }
      : {}),
    latencyMs: Date.now() - startedAt,
    flatAgents: state.flatAgents,
  };
  return { content: finalContent, haltReason, stats };
}
