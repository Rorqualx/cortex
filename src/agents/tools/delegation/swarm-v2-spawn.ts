// Spawn-subagents tool factory + runOneSubAgentV2.
//
// `makeSpawnSubagentsTool(parentDepth, parentInput, client, sharedState)`
// returns an ExtraTool that, when invoked by an explore-loop, fans out N
// parallel sub-agents (each itself a runExploreLoop). Recursion safety
// comes from FOUR independent stops (see plan §"Concurrency & recursion"):
//
//   1. Depth cap — sub-agents at depth >= maxDepth don't receive the tool.
//   2. Cumulative counter — when spawnedCount >= maxTotalSubagents, omit.
//   3. 80% wall soft-gate — when elapsed/wall > 0.8, omit.
//   4. Handler-time race guard — even if (1)-(3) miss, the handler returns
//      a structured error and the model recovers via its next iter.

import { runExploreLoop, type ExploreInput, type ExploreResult } from "./explore-loop.js";
import { EXPLORE_TOOL_NAMES, type ExploreToolName } from "./explore-tools.js";
import type { LlmClient } from "./providers/types.js";
import type { SwarmV2SharedState } from "./swarm-v2-state.js";
import {
  SUBAGENT_CONTENT_CAP_TO_PARENT,
  type ExtraTool,
  type ExtraToolCtx,
  type ExtraToolResult,
  type SubagentV2Result,
  type SubtaskV2Spec,
  type SwarmV2Input,
} from "./swarm-v2-types.js";

// === Tool-definition factory ===

const SUBAGENT_FLOOR_ITERS = 12; // mirror v1's SUBAGENT_MIN_ITER_FLOOR

/**
 * Per-sub-agent default iter cap. Kimi's K2.6 reasoning-runaway is monotonic
 * with iter count — verified r12-r15 — so kimi caps lower than glm/deepseek.
 */
function defaultIterCap(provider: LlmClient["provider"]): number {
  return provider === "kimi" ? 18 : 30;
}

/**
 * Build the OpenAI-compat tool definition the LLM sees. Description includes
 * an explicit list of available `allowed_tools` values + the recursion budget
 * hints (current depth, remaining slots) so the model knows what's left.
 */
function makeSpawnToolDefinition(
  parentDepth: number,
  state: SwarmV2SharedState,
): ExtraTool["definition"] {
  const remaining = state.maxTotalSubagents - state.spawnedCount;
  const childDepth = parentDepth + 1;
  return {
    type: "function",
    function: {
      name: "spawn_subagents",
      description:
        `Fan out N parallel ReAct sub-agents (each a full explore-loop with the standard 10 fs/web/bash tools). ` +
        `Sub-agents run concurrently; you receive their results before deciding the next round. ` +
        `Current depth=${parentDepth}, child depth=${childDepth}/${state.maxDepth}. ` +
        `Tree budget: ${remaining}/${state.maxTotalSubagents - 1} sub-agent slots remaining. ` +
        `Max 16 subtasks per call; call MULTIPLE times across iterations as findings emerge. ` +
        `Subtasks within ONE call must be independent (no inter-agent communication). ` +
        `Each sub-agent finishes with a synthesis turn; their content is returned to you truncated to ${SUBAGENT_CONTENT_CAP_TO_PARENT} chars.`,
      parameters: {
        type: "object",
        properties: {
          subtasks: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: {
              type: "object",
              required: ["objective", "allowed_tools", "thinking"],
              properties: {
                objective: {
                  type: "string",
                  minLength: 10,
                  description:
                    "Imperative one-sentence task. Self-contained — sub-agents only see this string + routed context, not the parent task.",
                },
                allowed_tools: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", enum: [...EXPLORE_TOOL_NAMES] },
                  description:
                    "Subset of the 10 fs/web/bash tools the sub-agent may use. Narrow when you can predict what's needed.",
                },
                thinking: {
                  type: "boolean",
                  description: "true for analytical sub-tasks; false for mechanical extraction.",
                },
                context_indices: {
                  type: "array",
                  items: { type: "integer", minimum: 0 },
                  description:
                    "Zero-based indices into the parent's context array. Empty = no context routed.",
                },
                max_iterations: {
                  type: "integer",
                  minimum: SUBAGENT_FLOOR_ITERS,
                  maximum: 50,
                  description: "Per-sub-agent iter cap. Honored within swarm-level cap.",
                },
              },
            },
          },
        },
        required: ["subtasks"],
      },
    },
  };
}

// === Validation of incoming subtasks ===

interface ValidationFailure {
  index: number;
  reason: string;
}

interface ValidatedSpec {
  spec: SubtaskV2Spec;
  index: number; // index in the user's subtasks array (0-based)
}

function validateSubtasks(
  raw: unknown,
): { ok: ValidatedSpec[]; failures: ValidationFailure[] } | { fatal: string } {
  if (!raw || typeof raw !== "object") return { fatal: "args must be an object" };
  const r = raw as Record<string, unknown>;
  const sub = r.subtasks;
  if (!Array.isArray(sub)) return { fatal: "args.subtasks must be an array" };
  if (sub.length === 0) return { fatal: "args.subtasks must have at least 1 element" };
  if (sub.length > 16) return { fatal: `args.subtasks max 16 per call (got ${sub.length})` };

  const ok: ValidatedSpec[] = [];
  const failures: ValidationFailure[] = [];
  const validToolNames: ReadonlySet<string> = new Set(EXPLORE_TOOL_NAMES);

  for (let i = 0; i < sub.length; i++) {
    const item = sub[i];
    if (!item || typeof item !== "object") {
      failures.push({ index: i, reason: "subtask must be an object" });
      continue;
    }
    const s = item as Record<string, unknown>;
    if (typeof s.objective !== "string" || s.objective.trim().length < 10) {
      failures.push({ index: i, reason: "objective must be a string of length >= 10" });
      continue;
    }
    if (!Array.isArray(s.allowed_tools) || s.allowed_tools.length === 0) {
      failures.push({ index: i, reason: "allowed_tools must be a non-empty array" });
      continue;
    }
    const tools: ExploreToolName[] = [];
    let toolErr: string | null = null;
    for (const t of s.allowed_tools) {
      if (typeof t !== "string" || !validToolNames.has(t)) {
        toolErr = `allowed_tools contains invalid tool name: ${JSON.stringify(t)}`;
        break;
      }
      tools.push(t as ExploreToolName);
    }
    if (toolErr) {
      failures.push({ index: i, reason: toolErr });
      continue;
    }
    if (typeof s.thinking !== "boolean") {
      failures.push({ index: i, reason: "thinking must be a boolean" });
      continue;
    }
    let contextIndices: number[] | undefined;
    if (s.context_indices !== undefined) {
      if (!Array.isArray(s.context_indices)) {
        failures.push({ index: i, reason: "context_indices must be an array of integers" });
        continue;
      }
      contextIndices = [];
      let ciErr = false;
      for (const v of s.context_indices) {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
          ciErr = true;
          break;
        }
        contextIndices.push(v);
      }
      if (ciErr) {
        failures.push({ index: i, reason: "context_indices must be non-negative integers" });
        continue;
      }
    }
    let maxIter: number | undefined;
    if (s.max_iterations !== undefined) {
      if (
        typeof s.max_iterations !== "number" ||
        !Number.isInteger(s.max_iterations) ||
        s.max_iterations < SUBAGENT_FLOOR_ITERS ||
        s.max_iterations > 50
      ) {
        failures.push({
          index: i,
          reason: `max_iterations must be integer in [${SUBAGENT_FLOOR_ITERS}, 50]`,
        });
        continue;
      }
      maxIter = s.max_iterations;
    }
    const out: SubtaskV2Spec = {
      objective: s.objective.trim(),
      allowed_tools: tools,
      thinking: s.thinking,
      ...(contextIndices !== undefined ? { context_indices: contextIndices } : {}),
      ...(maxIter !== undefined ? { max_iterations: maxIter } : {}),
    };
    ok.push({ spec: out, index: i });
  }

  return { ok, failures };
}

// === runOneSubAgentV2 ===

interface RunOneSubAgentV2Input {
  parentInput: SwarmV2Input;
  client: LlmClient;
  state: SwarmV2SharedState;
  spec: SubtaskV2Spec;
  parentIndex: number;
  myIndex: number;
  myDepth: number;
}

async function runOneSubAgentV2(input: RunOneSubAgentV2Input): Promise<SubagentV2Result> {
  const { parentInput, client, state, spec, parentIndex, myIndex, myDepth } = input;
  const childIndices: number[] = [];
  const start = Date.now();

  // === Acquire semaphore slot (depth >= 1 always; depth 0 / CEO is outside) ===
  await state.semaphore.acquire();

  try {
    // Build context slice from parent's contextItems via context_indices.
    const contextSlice =
      spec.context_indices && parentInput.contextItems
        ? spec.context_indices
            .filter((i) => i >= 0 && i < parentInput.contextItems!.length)
            .map((i) => parentInput.contextItems![i]!)
        : undefined;

    // Per-provider iter cap default. Plan §"Per-provider max_iterations_per_subagent":
    // resolved at schema-factory time, but if no value reached this point we use
    // the same per-provider default at runtime as defense-in-depth.
    const iterCapDefault = parentInput.maxIterationsPerSubagent ?? defaultIterCap(client.provider);
    const subagentMaxIter = Math.max(SUBAGENT_FLOOR_ITERS, spec.max_iterations ?? iterCapDefault);

    // Build extraTools for THIS sub-agent. Recursion safety: omit
    // spawn_subagents if this sub-agent's children would exceed depth or
    // budget caps.
    const elapsedMs = Date.now() - state.startedAt;
    const childDepth = myDepth + 1;
    const canSpawnChildren =
      childDepth <= state.maxDepth &&
      !state.isSpawnDisabled(elapsedMs) &&
      state.spawnedCount < state.maxTotalSubagents;
    const extraTools: ExtraTool[] = canSpawnChildren
      ? [makeSpawnSubagentsTool(myIndex, myDepth, parentInput, client, state, childIndices)]
      : [];

    // Sub-agent budget: same as v1's 10000-floor (Moonshot guidance for K2 thinking
    // models recommends >=16k but our v1 r15 negative result showed budget bumps
    // overflow the parent-scope aggregator; we keep the proven 10000).
    const subagentBudget = 10000;

    const subagentInput: ExploreInput = {
      task: spec.objective,
      roots: parentInput.roots,
      contextItems: contextSlice,
      model: parentInput.subagentModel ?? parentInput.model,
      thinking: spec.thinking,
      format: "markdown", // sub-agents always emit markdown for the CEO to consume
      maxIterations: subagentMaxIter,
      maxOutputTokens: subagentBudget,
      allowedTools: spec.allowed_tools,
      wallTimeMs: Math.max(60_000, parentInput.wallTimeMs ?? 1_200_000),
      maxBudgetUsd: parentInput.maxBudgetUsd,
      extraTools,
      wallSignal: state.wallController.signal,
      wallDeadlineMs: state.startedAt + state.wallMs, // shared-wall deadline for synthesis reserve
      // Slot management hooks — passed to spawn_subagents handler via
      // ExtraToolCtx. When this sub-agent itself spawns children, it must
      // release its semaphore slot before awaiting them (RAII).
      extraToolCtx: {
        releaseParentSlot: () => state.semaphore.release(),
        reacquireParentSlot: () => state.semaphore.acquire(),
      },
    };

    let result: ExploreResult | null = null;
    let runError: string | null = null;
    try {
      result = await runExploreLoop(client, subagentInput);
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
    }

    if (!result) {
      return {
        index: myIndex,
        parentIndex,
        depth: myDepth,
        ok: false,
        objective: spec.objective,
        allowedTools: spec.allowed_tools,
        thinking: spec.thinking,
        iterations: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - start,
        error: runError ?? "explore-loop returned null",
        content: "",
        childIndices,
      };
    }

    const { stats, content } = result;
    // Empty-content guard: same defense as v1 (swarm-loop.ts:531). K2.6
    // reasoning runaway can produce subtype=success with empty content.
    const subtypeOk = stats.subtype === "success";
    const contentEmpty = (content ?? "").trim().length === 0;
    const finalOk = subtypeOk && !contentEmpty;
    const errorReason = !subtypeOk
      ? `subtype=${stats.subtype} halt=${stats.haltReason}`
      : contentEmpty
        ? `subtype=success but empty content (likely reasoning runaway at synthesis turn; outputTokens=${stats.outputTokens})`
        : undefined;

    return {
      index: myIndex,
      parentIndex,
      depth: myDepth,
      ok: finalOk,
      objective: spec.objective,
      allowedTools: spec.allowed_tools,
      thinking: spec.thinking,
      iterations: stats.iterations,
      toolCalls: stats.toolCalls,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      ...(stats.cacheHitTokens !== undefined ? { cacheHitTokens: stats.cacheHitTokens } : {}),
      latencyMs: Date.now() - start,
      ...(stats.costUsd !== undefined ? { costUsd: stats.costUsd } : {}),
      ...(stats.stopReason ? { finishReason: stats.stopReason } : {}),
      ...(errorReason ? { error: errorReason } : {}),
      content: content ?? "",
      childIndices,
    };
  } finally {
    state.semaphore.release();
  }
}

// === The spawn_subagents tool factory ===

/**
 * Build the spawn_subagents extra-tool for an agent at depth `parentDepth`.
 * Returned tool:
 *   - definition advertises current tree state (depth, remaining slots)
 *   - handler validates input, reserves indices atomically, fans out via
 *     Promise.allSettled, renders results back to the parent
 *
 * `childIndices` is shared with `runOneSubAgentV2` so the parent's result
 * can list the indices it spawned.
 */
export function makeSpawnSubagentsTool(
  parentIndex: number,
  parentDepth: number,
  parentInput: SwarmV2Input,
  client: LlmClient,
  state: SwarmV2SharedState,
  parentChildIndices?: number[],
): ExtraTool {
  return {
    name: "spawn_subagents",
    definition: makeSpawnToolDefinition(parentDepth, state),
    handler: async (args, ctx: ExtraToolCtx): Promise<ExtraToolResult> => {
      // Track this spawn round if it's coming from the CEO.
      if (parentDepth === 0) state.spawnRoundsByCeo++;

      const validation = validateSubtasks(args);
      if ("fatal" in validation) {
        return {
          content: `[spawn_subagents error] ${validation.fatal}\n\nReturn the next iteration with a valid subtasks array.`,
          meta: { error: "fatal_validation", reason: validation.fatal },
        };
      }
      if (validation.ok.length === 0) {
        const failureLines = validation.failures
          .map((f) => `  [${f.index}] ${f.reason}`)
          .join("\n");
        return {
          content: `[spawn_subagents error] all ${validation.failures.length} subtasks failed validation:\n${failureLines}\n\nReturn the next iteration with valid subtasks.`,
          meta: { error: "all_invalid", failures: validation.failures },
        };
      }

      // Recursion budget guard: refuse if depth or count would be exceeded.
      const childDepth = parentDepth + 1;
      if (childDepth > state.maxDepth) {
        return {
          content: `[spawn_subagents error] depth cap reached (${parentDepth}/${state.maxDepth}); cannot spawn deeper. Synthesize from what you have.`,
          meta: { error: "depth_cap_exceeded", parentDepth, maxDepth: state.maxDepth },
        };
      }

      // Atomic slot reservation. tryReserveAgentSlot is sync in Node;
      // increment-and-check happens in one tick. For each subtask, reserve
      // an index up front; if any reservation fails, truncate the request
      // and report which were dropped.
      const reserved: Array<{ vs: (typeof validation.ok)[number]; index: number }> = [];
      const dropped: Array<{ vs: (typeof validation.ok)[number]; reason: string }> = [];

      for (const vs of validation.ok) {
        const idx = state.tryReserveAgentSlot();
        if (idx === null) {
          dropped.push({ vs, reason: "spawn budget exhausted" });
        } else {
          reserved.push({ vs, index: idx });
        }
      }

      // Parent-slot release: if we hold a semaphore slot (depth >= 1), release
      // before awaiting children. RAII pattern; reacquire in finally.
      ctx.releaseParentSlot?.();

      let children: SubagentV2Result[] = [];
      try {
        const promises = reserved.map((r) =>
          runOneSubAgentV2({
            parentInput,
            client,
            state,
            spec: r.vs.spec,
            parentIndex,
            myIndex: r.index,
            myDepth: childDepth,
          }).then((res) => {
            state.recordAgent(res);
            parentChildIndices?.push(res.index);
            return res;
          }),
        );
        const settled = await Promise.allSettled(promises);
        children = settled.map((s, i) => {
          if (s.status === "fulfilled") return s.value;
          // Promise itself rejected (defensive — runOneSubAgentV2 catches its own throws).
          const r = reserved[i]!;
          const failed: SubagentV2Result = {
            index: r.index,
            parentIndex: parentIndex,
            depth: childDepth,
            ok: false,
            objective: r.vs.spec.objective,
            allowedTools: r.vs.spec.allowed_tools,
            thinking: r.vs.spec.thinking,
            iterations: 0,
            toolCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            error: s.reason instanceof Error ? s.reason.message : String(s.reason),
            content: "",
            childIndices: [],
          };
          state.recordAgent(failed);
          parentChildIndices?.push(failed.index);
          return failed;
        });
      } finally {
        // Reacquire parent slot. Briefly blocks if pool oversubscribed, OK.
        await ctx.reacquireParentSlot?.();
      }

      // Render results back to the parent.
      const okCount = children.filter((c) => c.ok).length;
      const failCount = children.length - okCount;
      const droppedNote =
        dropped.length > 0
          ? `\n\nDROPPED (${dropped.length}, spawn budget exhausted):\n` +
            dropped.map((d) => `  [${d.vs.index}] ${d.vs.spec.objective.slice(0, 80)}`).join("\n")
          : "";
      const validationNote =
        validation.failures.length > 0
          ? `\n\nVALIDATION FAILURES (${validation.failures.length}):\n` +
            validation.failures.map((f) => `  [${f.index}] ${f.reason}`).join("\n")
          : "";

      const header =
        `spawn_subagents complete: ${okCount}/${children.length} ok, ${failCount} failed.\n` +
        `Tree state: spawned=${state.spawnedCount - 1}/${state.maxTotalSubagents - 1}, ` +
        `depth_reached=${state.maxDepthReached}.` +
        droppedNote +
        validationNote;

      const bodies = children
        .map((c) => {
          const tag = c.ok ? "ok" : `FAILED: ${c.error ?? "unknown"}`;
          const childNote =
            c.childIndices.length > 0 ? `, spawned ${c.childIndices.length} children` : "";
          const truncatedContent =
            c.content.length > SUBAGENT_CONTENT_CAP_TO_PARENT
              ? c.content.slice(0, SUBAGENT_CONTENT_CAP_TO_PARENT) +
                `… [+${c.content.length - SUBAGENT_CONTENT_CAP_TO_PARENT} chars]`
              : c.content;
          // Show any non-empty content, even from a not-ok child. A cap-halted
          // sub-agent (iter/wall/byte/budget) still emits a forced synthesis —
          // that work is useful to the CEO and must not be hidden as "(no
          // content)". The FAILED tag already flags it as a cap/partial result.
          const hasContent = c.content.trim().length > 0;
          return (
            `\n[Sub-agent ${c.index} — ${tag}, depth=${c.depth}, iters=${c.iterations}, ${(c.latencyMs / 1000).toFixed(1)}s${childNote}]\n` +
            (hasContent ? truncatedContent : "(no content)")
          );
        })
        .join("\n");

      return {
        content: header + bodies,
        meta: {
          okCount,
          failCount,
          totalThisCall: children.length,
          droppedCount: dropped.length,
          validationFailureCount: validation.failures.length,
        },
      };
    },
  };
}
