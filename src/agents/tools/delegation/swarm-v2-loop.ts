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
import { makeSpawnSubagentsTool } from "./swarm-v2-spawn.js";
import { makeSharedState } from "./swarm-v2-state.js";
import {
  MAX_DEPTH_HARD,
  MAX_TOTAL_SUBAGENTS_HARD,
  type SubagentV2Result,
  type SwarmV2Input,
  type SwarmV2HaltReason,
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
  const ceoChildIndices: number[] = [];
  const spawnTool = makeSpawnSubagentsTool(0, 0, input, client, state, ceoChildIndices);

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
    extraTools: [spawnTool],
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

  // Build the CEO's record (always at index 0 in flatAgents).
  const ceoRecord: SubagentV2Result = ceoResult
    ? {
        index: 0,
        parentIndex: null,
        depth: 0,
        ok: ceoResult.stats.subtype === "success" && (ceoResult.content ?? "").trim().length > 0,
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
        content: ceoResult.content ?? "",
        childIndices: ceoChildIndices,
      }
    : {
        index: 0,
        parentIndex: null,
        depth: 0,
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

  // === Adjudicate final answer (resolves blocker #5: CEO synthesis termination) ===

  const ceoContent = (ceoResult?.content ?? "").trim();
  const wallAborted = state.wallController.signal.aborted;
  const ceoHalt = ceoResult?.stats.haltReason;

  let haltReason: SwarmV2HaltReason;
  let finalContent: string;

  if (!ceoResult) {
    haltReason = "error";
    finalContent = `[swarm v2 error] CEO explore-loop failed: ${runError ?? "unknown"}`;
  } else if (ceoContent.length === 0) {
    // Empty-content fallback. K2.6 risk acknowledged in plan. Mirror v1's
    // fallbackSynthesis pattern.
    haltReason = "ceo_synthesis_empty";
    finalContent = fallbackSynthesisV2(input.task, state.flatAgents, "CEO produced empty content");
  } else if (wallAborted) {
    // HARD wall abort: the wall fired before/while the CEO synthesized, so
    // ceoContent is a partial or mid-reasoning fragment — NOT an answer. Never
    // discard the sub-agents' completed verdicts; emit them verbatim and append
    // the CEO's partial notes as context. (Layer 1's synthesis reserve makes
    // this path rare; this is the safety net for when synthesis overruns it.)
    haltReason = "wall_cap";
    const okSubsForWall = state.flatAgents.filter((a) => a.depth > 0 && a.ok);
    if (okSubsForWall.length > 0) {
      finalContent = fallbackSynthesisV2(
        input.task,
        state.flatAgents,
        "wall budget hit before the CEO could synthesize",
      );
      if (ceoContent.length > 0) {
        finalContent += `\n\n## CEO partial notes (incomplete — wall hit mid-synthesis)\n\n${ceoContent}`;
      }
    } else {
      finalContent =
        ceoContent.length > 0
          ? ceoContent
          : fallbackSynthesisV2(
              input.task,
              state.flatAgents,
              "wall budget hit; no successful sub-agents",
            );
    }
  } else if (ceoHalt === "wall_cap") {
    // Graceful soft-wall synthesis: the CEO crossed the synthesis-reserve
    // deadline and produced a real answer before the hard wall fired. ceoContent
    // is trustworthy here (it came from the forced synthesis turn).
    haltReason = "wall_cap";
    finalContent = ceoContent;
  } else if (ceoHalt === "iter_cap") {
    haltReason = "ceo_iter_cap";
    finalContent = ceoContent;
  } else if (ceoHalt === "no_progress") {
    haltReason = "ceo_no_progress";
    finalContent = ceoContent;
  } else if (
    state.spawnedCount > maxTotalSubagents - 1 &&
    state.flatAgents.filter((a) => a.depth > 0 && !a.ok).length ===
      state.flatAgents.filter((a) => a.depth > 0).length
  ) {
    // Budget exhausted AND every sub-agent failed
    haltReason = "spawn_budget_exhausted";
    finalContent = fallbackSynthesisV2(
      input.task,
      state.flatAgents,
      "spawn budget exhausted with all sub-agents failed",
    );
  } else if (
    state.flatAgents.filter((a) => a.depth > 0).length > 0 &&
    state.flatAgents.filter((a) => a.depth > 0 && a.ok).length === 0
  ) {
    // Sub-agents were spawned but all failed
    haltReason = "all_subagents_failed";
    // CEO content still exists (we already handled empty above), so use it but flag.
    finalContent = `[swarm v2 note] all ${state.flatAgents.filter((a) => a.depth > 0).length} sub-agents failed; CEO synthesized from fs-tool work alone:\n\n${ceoContent}`;
  } else {
    haltReason = "stop";
    finalContent = ceoContent;
  }

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
    latencyMs: Date.now() - startedAt,
    flatAgents: state.flatAgents,
  };
  return { content: finalContent, haltReason, stats };
}

// === fallbackSynthesisV2 (mirrors v1's fallbackSynthesis pattern) ===

function fallbackSynthesisV2(task: string, agents: SubagentV2Result[], reason: string): string {
  const subagents = agents.filter((a) => a.depth > 0);
  if (subagents.length === 0) {
    return `[swarm v2 fallback] ${reason}; no sub-agents were spawned. Original task:\n${task}`;
  }
  const okSubs = subagents.filter((a) => a.ok);
  const failSubs = subagents.filter((a) => !a.ok);
  const lines: string[] = [
    `[swarm v2 fallback synthesis] ${reason}; emitting raw sub-agent outputs verbatim.`,
    "",
    `Original task: ${task}`,
    "",
    `Sub-agent results: ${okSubs.length} ok, ${failSubs.length} failed.`,
    "",
  ];
  for (const a of okSubs) {
    lines.push(
      `## Sub-agent ${a.index} (depth=${a.depth}, ${a.iterations} iters, ${(a.latencyMs / 1000).toFixed(1)}s)`,
      `**Objective:** ${a.objective}`,
      "",
      a.content,
      "",
    );
  }
  if (failSubs.length > 0) {
    lines.push("## Failed sub-agents", "");
    for (const a of failSubs) {
      lines.push(`- Sub-agent ${a.index} (depth=${a.depth}): ${a.error ?? "unknown error"}`);
    }
  }
  return lines.join("\n");
}
