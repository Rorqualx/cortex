// Swarm loop for the *__swarm tools (one per provider). Three-stage pipeline:
//
//   1. DECOMPOSE — one chat-completion call where a coordinator emits a JSON
//      list of [1, num_agents] independent sub-tasks, each with an objective,
//      a slice of the user's context (`context_indices`), a `thinking` flag,
//      an `allowed_tools` whitelist, and an iteration hint.
//
//   2. FAN OUT — N parallel `runExploreLoop()` invocations (full ReAct loops
//      with the standard 10-tool catalog), all sharing one AbortController so
//      the swarm's wall-clock cap preempts every sub-agent at once. Promise
//      .allSettled means partial failures don't kill siblings.
//
//   3. AGGREGATE — one chat-completion call where an aggregator synthesizes
//      the sub-agent outputs into one coherent answer to the original task.
//
// Total cost = decompose + N×explore-loop + aggregate. The pipeline emulates
// Kimi's Agent Swarm web product (no public API exists). When the coordinator
// can't usefully parallelize, it returns 1 sub-task and the swarm degrades to
// "single explore-loop + framing call + synthesis call" — still useful for
// the structured think-then-act-then-explain shape.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runExploreLoop,
  type ExploreInput,
  type ExploreResult,
  type ExploreStats,
} from "./explore-loop.js";
import { EXPLORE_TOOL_NAMES, type ExploreToolName } from "./explore-tools.js";
import { parseLlmJson } from "./llm-json.js";
import { estimateCostUsd } from "./pricing.js";
import type { LlmCallResult, LlmClient, Provider } from "./providers/types.js";
import { LlmError } from "./providers/types.js";
import { SYSTEM_PROMPTS } from "./system-prompts.js";

// === Defaults & ceilings ===
const DEFAULT_NUM_AGENTS_MIN = 3;
const DEFAULT_NUM_AGENTS_MAX = 8;
const DEFAULT_NUM_AGENTS_HARD_CEILING = 16;
const DEFAULT_MAX_ITER_PER_AGENT = 30;
// Floor on each sub-agent's effective max_iterations. The coordinator often
// picks 6-8 iters which is fine for shallow tasks but too low for fs-tool
// exploration (verified swarm-r1: every codebase_explore sub-agent hit iter_cap
// at 6-8; r3 showed 10 was still tight — 1-2 of 3 sub-agents hit cap on
// codebase_explore). 12 is the minimum that lets a sub-agent do meaningful
// list_dir → glob → grep → read sequences with room to converge.
// Mirrored at the schema level via `max_iterations_per_agent.min(12)`. The
// runtime applies it again as a defense-in-depth invariant — if a programmatic
// caller bypasses the schema, the floor still wins over a low cap.
const SUBAGENT_MIN_ITER_FLOOR = 12;
const DEFAULT_WALL_MS = 1_200_000; // 20 min total swarm wall budget (head/tail reservations + 14-min fanout slice)
const DEFAULT_DECOMPOSE_MAX_TOKENS = 4000;
const DEFAULT_AGGREGATE_MIN_TOKENS = 4000;
const DECOMPOSE_THINKING_DEFAULT = true; // coordinator benefits from CoT when picking how to split
const PER_AGENT_BUDGET_FLOOR_USD = 0.1;

// === Reasoning floor — duplicated from index.ts. Keep in sync. ===
function reasoningFloor(model: string, thinking: boolean, requested: number): number {
  const isK2Thinking = /^kimi-k2\.\d/.test(model) && thinking;
  return Math.max(requested, isK2Thinking ? 6000 : 3000);
}

// === Per-provider sub-agent default model. ===
//
// Sub-agents do the bulk of work — for capability-tied workhorse roles we
// pick the cheaper-but-strong model on each provider. Coordinator + aggregator
// keep the parent's `model` (the top-tier reasoning model) since structured
// decomposition + synthesis benefit most from depth.
const SUBAGENT_DEFAULT_MODEL: Record<Provider, string> = {
  zai: "glm-4.7",
  deepseek: "deepseek-v4-flash",
  kimi: "kimi-k2.6",
};

export type SwarmInput = {
  task: string;
  roots: string[];
  contextItems?: string[] | undefined;
  filePaths?: string[] | undefined;
  /** Coordinator + aggregator model (and sub-agent fallback if subagentModel unset). */
  model: string;
  /** Sub-agent model. When omitted, falls back to SUBAGENT_DEFAULT_MODEL[provider]. */
  subagentModel?: string | undefined;
  thinking: boolean;
  format: "text" | "markdown" | "json";
  maxOutputTokens: number;
  numAgents?: number | undefined; // hard cap; coordinator can return fewer
  maxIterationsPerAgent?: number | undefined;
  allowedTools?: ExploreToolName[] | undefined;
  disallowedTools?: ExploreToolName[] | undefined;
  wallTimeMs?: number | undefined;
  maxBudgetUsd?: number | undefined;
};

export type SwarmAgentResult = {
  index: number;
  ok: boolean;
  objective: string;
  contextIndices: number[];
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
  // Sub-agent's final synthesis content. Truncated for storage cap if huge.
  content: string;
};

export type SwarmStats = {
  provider: Provider;
  models: { coordinator: string; aggregator: string; subagent: string };
  num_agents: number;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
    costUsd: number;
    wallMs: number;
  };
  per_stage: {
    decompose: {
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
      retries: number;
      costUsd?: number;
    };
    fanout: {
      agents: number;
      ok: number;
      failed: number;
      max_latency_ms: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost_usd?: number;
      total_iterations: number;
      total_tool_calls: number;
    };
    aggregate: { inputTokens: number; outputTokens: number; latencyMs: number; costUsd?: number };
  };
  agents: SwarmAgentResult[];
  haltReason: SwarmHaltReason;
  tracePath?: string;
};

export type SwarmHaltReason =
  | "stop"
  | "wall_cap"
  | "budget_cap"
  | "decompose_failed"
  | "aggregate_failed"
  | "all_subagents_failed";

export type SwarmResult = {
  content: string;
  stats: SwarmStats;
};

// === Trace ===

type SwarmTraceEvent =
  | { kind: "user_task"; task: string; numAgentsRequested: number | undefined; ts: number }
  | { kind: "decompose_retry"; reason: string; latencyMs: number; ts: number }
  | {
      kind: "decompose_complete";
      subtasks: SubtaskSpec[];
      retries: number;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
      ts: number;
    }
  | { kind: "decompose_failed"; reason: string; retries: number; latencyMs: number; ts: number }
  | { kind: "subagent_start"; index: number; objective: string; allowedTools: string[]; ts: number }
  | {
      kind: "subagent_complete";
      index: number;
      ok: boolean;
      finishReason?: string;
      iterations: number;
      toolCalls: number;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
      error?: string;
      ts: number;
    }
  | {
      kind: "aggregate_complete";
      finalContentChars: number;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
      ts: number;
    }
  | { kind: "halt"; reason: SwarmHaltReason; ts: number };

async function appendTrace(traceFile: string | null, event: SwarmTraceEvent): Promise<void> {
  if (!traceFile) return;
  try {
    await fs.appendFile(traceFile, JSON.stringify(event) + "\n");
  } catch {
    // tracing must not affect correctness
  }
}

async function openTraceFile(provider: Provider): Promise<string | null> {
  if (process.env["MCP_SWARM_TRACE"] !== "1") return null;
  const dir = path.join(os.homedir(), ".claude", "mcp-swarm-trace", provider);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    return null;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${ts}.jsonl`);
}

// === Coordinator JSON parsing ===

type SubtaskSpec = {
  id: number;
  objective: string;
  context_indices: number[];
  thinking: boolean;
  allowed_tools: ExploreToolName[];
  max_iterations: number;
};

const VALID_TOOL_NAMES = new Set<string>(EXPLORE_TOOL_NAMES);

function parseDecomposition(
  raw: string,
  numAgentsCap: number,
): { subtasks: SubtaskSpec[] } | { error: string } {
  const result = parseLlmJson(raw);
  if ("err" in result) {
    return { error: `coordinator JSON parse failed (${result.err.kind}): ${result.err.message}` };
  }
  const parsed = result.ok;
  if (!parsed || typeof parsed !== "object") {
    return { error: "coordinator response was not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const subtasks = obj["subtasks"];
  if (!Array.isArray(subtasks)) {
    return { error: "coordinator response missing 'subtasks' array" };
  }
  const out: SubtaskSpec[] = [];
  for (let i = 0; i < Math.min(subtasks.length, numAgentsCap); i++) {
    const st = subtasks[i] as Record<string, unknown>;
    if (!st || typeof st !== "object") {
      return { error: `subtask[${i}] is not an object` };
    }
    const objective = typeof st["objective"] === "string" ? st["objective"].trim() : "";
    if (!objective) {
      return { error: `subtask[${i}].objective missing or empty` };
    }
    const idRaw = st["id"];
    const id = typeof idRaw === "number" ? Math.trunc(idRaw) : i + 1;
    const ciRaw = Array.isArray(st["context_indices"]) ? (st["context_indices"] as unknown[]) : [];
    const context_indices = ciRaw.filter(
      (x): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0,
    );
    const thinking = typeof st["thinking"] === "boolean" ? st["thinking"] : true;
    const atRaw = Array.isArray(st["allowed_tools"]) ? (st["allowed_tools"] as unknown[]) : [];
    const allowed_tools = atRaw
      .filter((x): x is string => typeof x === "string")
      .filter((x) => VALID_TOOL_NAMES.has(x)) as ExploreToolName[];
    if (allowed_tools.length === 0) {
      return {
        error: `subtask[${i}].allowed_tools must be non-empty subset of [${EXPLORE_TOOL_NAMES.join(",")}]`,
      };
    }
    const maxIterRaw = st["max_iterations"];
    const max_iterations =
      typeof maxIterRaw === "number" &&
      Number.isInteger(maxIterRaw) &&
      maxIterRaw >= 1 &&
      maxIterRaw <= 50
        ? maxIterRaw
        : 8;
    out.push({ id, objective, context_indices, thinking, allowed_tools, max_iterations });
  }
  if (out.length === 0) {
    return { error: "coordinator returned zero usable subtasks" };
  }
  return { subtasks: out };
}

// r14 tested a kimi+roots-aware "prefer 5-6 narrow sub-tasks" hint here on
// the theory that narrower slices would fit within iter_cap=18. Result:
// kimi codebase_explore went 75→70 with 5 of 6 sub-agents failing at
// iter_cap=18 (vs r11's 1 of 3). Counter-intuitive but coherent: K2.6
// sub-agents that *finish naturally* succeed; ones that *grind to
// iter_cap* fail with empty content — regardless of slice width. Broad
// slices give more landmarks per slice → higher chance of natural
// completion. Narrow slices have fewer anchors → K2.6 iterates
// uncertainly and grinds to iter_cap. Removed; documenting so future-
// me doesn't try the same fix again.
function buildCoordinatorPrompt(input: SwarmInput): string {
  const lines = [
    `User task:\n${input.task}`,
    "",
    `Hard cap: at most ${input.numAgents ?? DEFAULT_NUM_AGENTS_MAX} sub-agents (return 1 if the task isn't parallelizable).`,
    `Soft target: ${DEFAULT_NUM_AGENTS_MIN}-${DEFAULT_NUM_AGENTS_MAX} sub-agents when the task admits parallel decomposition.`,
  ];
  if (input.contextItems && input.contextItems.length > 0) {
    lines.push(
      "",
      `Available context items (use \`context_indices\` to route):`,
      ...input.contextItems.map(
        (c, i) => `  [${i}] (${Buffer.byteLength(c, "utf8")} bytes) ${truncate(c, 200)}`,
      ),
    );
  }
  if (input.roots.length > 0) {
    lines.push("", `Filesystem roots sub-agents may search: ${input.roots.join(", ")}`);
  }
  lines.push(
    "",
    "Return JSON only (no prose, no markdown fences). One sub-task per element of the `subtasks` array.",
  );
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [+${s.length - max} chars]`;
}

function buildAggregatorPrompt(
  task: string,
  subtasks: SubtaskSpec[],
  agentResults: SwarmAgentResult[],
  format: SwarmInput["format"],
): string {
  const lines = [
    `Original task:\n${task}`,
    "",
    `Coordinator's decomposition (${subtasks.length} sub-task(s)):`,
    ...subtasks.map((s, i) => `  [${i + 1}] ${s.objective}`),
    "",
    `Sub-agent results:`,
  ];
  for (let i = 0; i < agentResults.length; i++) {
    const r = agentResults[i]!;
    lines.push(
      "",
      `--- Sub-agent ${i + 1} (${r.ok ? "ok" : `FAILED: ${r.error ?? "unknown error"}`}) ---`,
    );
    if (r.ok) {
      lines.push(r.content || "[sub-agent produced no content]");
    } else {
      lines.push("[no content — sub-agent failed]");
    }
  }
  lines.push(
    "",
    `Synthesize a single coherent answer to the original task in format=${format}. Apply the synthesis rules from your system prompt.`,
  );
  return lines.join("\n");
}

// === Sub-agent budget split ===

function perAgentWallMs(swarmWall: number, n: number): number {
  // Fanout slice = swarm wall minus ~6 min reserved for decompose+aggregate.
  // Each agent gets the full fanout slice (they run in parallel).
  const reservedHead = Math.min(180_000, Math.floor(swarmWall * 0.25));
  const reservedTail = Math.min(180_000, Math.floor(swarmWall * 0.25));
  const fanoutSlice = Math.max(60_000, swarmWall - reservedHead - reservedTail);
  return Math.max(60_000, Math.min(fanoutSlice, fanoutSlice));
  // Note: identical for all N because they run in parallel — no division.
  void n;
}

function perAgentBudgetUsd(swarmBudget: number | undefined, n: number): number | undefined {
  if (swarmBudget === undefined) return undefined;
  // Reserve ~30% of budget for decompose + aggregate; split the remainder.
  const fanoutBudget = swarmBudget * 0.7;
  const per = fanoutBudget / Math.max(1, n);
  return Math.max(PER_AGENT_BUDGET_FLOOR_USD, per);
}

function intersectAllowedTools(
  swarmAllowed: ExploreToolName[] | undefined,
  swarmDisallowed: ExploreToolName[] | undefined,
  subtaskAllowed: ExploreToolName[],
): { allowed: ExploreToolName[]; disallowed: ExploreToolName[] } {
  // Sub-agent's allowed = subtaskAllowed ∩ swarmAllowed (when set).
  let allowed: ExploreToolName[];
  if (swarmAllowed && swarmAllowed.length > 0) {
    const swarmSet = new Set(swarmAllowed);
    allowed = subtaskAllowed.filter((t) => swarmSet.has(t));
  } else {
    allowed = subtaskAllowed;
  }
  // Disallowed always comes from the swarm-level setting (caller's master kill switch).
  const disallowed = swarmDisallowed ?? [];
  return { allowed, disallowed };
}

// === Stage 1: decompose ===

async function decompose(
  client: LlmClient,
  input: SwarmInput,
  signal: AbortSignal,
  traceFile: string | null,
): Promise<
  | { result: { subtasks: SubtaskSpec[] }; raw: LlmCallResult; retries: number }
  | { error: string; latencyMs: number; retries: number }
> {
  const numAgentsCap = Math.min(
    input.numAgents ?? DEFAULT_NUM_AGENTS_MAX,
    DEFAULT_NUM_AGENTS_HARD_CEILING,
  );
  const start = Date.now();
  const basePrompt = buildCoordinatorPrompt({ ...input, numAgents: numAgentsCap });

  // Up to 2 attempts: first the clean prompt, then a corrective retry that
  // appends the validator's complaint and restates the schema. One retry
  // budget — if the model can't comply twice, the system prompt is the actual
  // problem.
  const MAX_ATTEMPTS = 2;
  let lastError = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) {
      return {
        error: "decompose aborted (wall_cap)",
        latencyMs: Date.now() - start,
        retries: attempt,
      };
    }
    const userPrompt = attempt === 0 ? basePrompt : buildCorrectivePrompt(basePrompt, lastError);
    let raw: LlmCallResult;
    try {
      raw = await client.call({
        systemPrompt: SYSTEM_PROMPTS.swarm_coordinator,
        userPrompt,
        maxOutputTokens: reasoningFloor(
          input.model,
          DECOMPOSE_THINKING_DEFAULT,
          DEFAULT_DECOMPOSE_MAX_TOKENS,
        ),
        thinking: DECOMPOSE_THINKING_DEFAULT,
        format: "json",
        model: input.model,
        contextItems: undefined,
      });
    } catch (err) {
      if (signal.aborted) {
        return {
          error: "decompose aborted (wall_cap)",
          latencyMs: Date.now() - start,
          retries: attempt,
        };
      }
      const msg = err instanceof LlmError || err instanceof Error ? err.message : String(err);
      // Network/provider failures don't benefit from a re-prompt — bail.
      return {
        error: `decompose call failed: ${msg}`,
        latencyMs: Date.now() - start,
        retries: attempt,
      };
    }
    const parsed = parseDecomposition(raw.content, numAgentsCap);
    if (!("error" in parsed)) {
      return { result: parsed, raw, retries: attempt };
    }
    lastError = parsed.error;
    if (attempt + 1 < MAX_ATTEMPTS) {
      await appendTrace(traceFile, {
        kind: "decompose_retry",
        reason: lastError,
        latencyMs: Date.now() - start,
        ts: Date.now(),
      });
      process.stderr.write(
        `[swarm] decompose attempt 1 rejected (${lastError}); retrying with corrective prompt\n`,
      );
    }
  }
  return { error: lastError, latencyMs: Date.now() - start, retries: MAX_ATTEMPTS - 1 };
}

function buildCorrectivePrompt(originalPrompt: string, validatorError: string): string {
  return [
    originalPrompt,
    "",
    "---",
    `Your previous response was REJECTED by the validator: ${validatorError}.`,
    "",
    "Return ONLY a JSON object matching the schema in your system prompt — no prose,",
    "no markdown fences. Every subtask MUST have:",
    "  - a non-empty `objective` string",
    "  - a non-empty `allowed_tools` array (subset of [list_dir, read_file, glob,",
    "    grep, web_fetch, web_search, write_file, write_files, notebook_edit, bash])",
    "  - `thinking`: boolean",
    "  - `max_iterations`: integer in [1, 50]",
    "  - `context_indices`: integer array (may be empty)",
    'Top-level shape: {"subtasks": [...]}.',
  ].join("\n");
}

// === Stage 2: fan out ===

async function runOneSubAgent(
  client: LlmClient,
  swarm: SwarmInput,
  spec: SubtaskSpec,
  index: number,
  signal: AbortSignal,
  perAgentBudget: number | undefined,
): Promise<SwarmAgentResult> {
  const start = Date.now();
  const { allowed, disallowed } = intersectAllowedTools(
    swarm.allowedTools,
    swarm.disallowedTools,
    spec.allowed_tools,
  );
  // Route only the requested context slice to this sub-agent.
  const contextSlice =
    swarm.contextItems && spec.context_indices.length > 0
      ? spec.context_indices
          .filter((i) => swarm.contextItems && i < swarm.contextItems.length)
          .map((i) => swarm.contextItems![i]!)
      : undefined;
  // Sub-agent's iter cap = swarm-level cap, floored at 12. Per-provider
  // default: kimi=18, others=DEFAULT_MAX_ITER_PER_AGENT (30). r7 showed
  // glm/deepseek codebase_explore needs 30 iters to thoroughly enumerate
  // (glm hit 100, deepseek 95 with 30; both stuck at 35-75 with 18). But
  // r7 also broke kimi multi_axis_audit (98→75): with 30-iter headroom
  // one of kimi's sub-agents iterated to 23 and produced too much input
  // for the kimi aggregator to digest, triggering its empty-content
  // pattern. r12 tried a roots-aware branch (kimi=30 for codebase_explore,
  // 18 for inline tasks) on the theory that the harness sub-agent failed
  // for nav-iter reasons; data showed the opposite — kimi codebase_explore
  // went 75→35 because K2.6's reasoning runaway is monotonic with
  // iteration count (more iters = higher empty-content rate at synthesis).
  // Capping kimi sub-agents at 18 keeps the runaway pattern bounded and
  // is the best stable kimi config. The coordinator's per-subtask
  // `max_iterations` hint is ignored — explore-loop's no-progress detector
  // handles early exit.
  const providerIterDefault = client.provider === "kimi" ? 18 : DEFAULT_MAX_ITER_PER_AGENT;
  const subagentMaxIter = Math.max(
    SUBAGENT_MIN_ITER_FLOOR,
    swarm.maxIterationsPerAgent ?? providerIterDefault,
  );
  const subagentModel = swarm.subagentModel ?? SUBAGENT_DEFAULT_MODEL[client.provider];
  // Sub-agent base output budget. 10000 across all providers.
  //
  // r15 tested kimi=20000 (Moonshot's documented floor for K2.6 thinking-on
  // is >=16,000 per https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model).
  // Result: kimi codebase_explore stayed at 75 (the 5-run ceiling), and
  // multi_axis regressed 98->88. Diagnosis: the larger sub-agent outputs
  // cascade into aggregator pressure — a 20k sub-agent producing 4-6k of
  // content gives the kimi aggregator (14k budget) more input than it can
  // synthesize before reasoning_content overflows. r15 codebase_explore
  // showed haltReason=aggregate_failed for kimi for that exact reason.
  // Reverting; the kimi 75 ceiling appears intrinsic to K2.6 model
  // behavior (Moonshot has documented bugs around reasoning-trace
  // corruption and tool-call-token leakage), not parameter-tunable from
  // our side.
  const subagentBudgetBase = 10000;
  const exploreInput: ExploreInput = {
    task: spec.objective,
    roots: swarm.roots,
    contextItems: contextSlice,
    model: subagentModel,
    thinking: spec.thinking,
    format: "markdown", // aggregator prefers structured input regardless of swarm output format
    maxIterations: subagentMaxIter,
    maxOutputTokens: reasoningFloor(subagentModel, spec.thinking, subagentBudgetBase),
    wallTimeMs: perAgentWallMs(swarm.wallTimeMs ?? DEFAULT_WALL_MS, 1),
    maxBudgetUsd: perAgentBudget,
    allowedTools: allowed,
    disallowedTools: disallowed.length > 0 ? disallowed : undefined,
  };

  const empty: SwarmAgentResult = {
    index,
    ok: false,
    objective: spec.objective,
    contextIndices: spec.context_indices,
    allowedTools: allowed,
    thinking: spec.thinking,
    iterations: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    content: "",
  };

  if (signal.aborted) {
    return { ...empty, latencyMs: Date.now() - start, error: "aborted before start" };
  }

  let result: ExploreResult;
  try {
    result = await runExploreLoop(client, exploreInput);
  } catch (err) {
    return {
      ...empty,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const stats: ExploreStats = result.stats;
  const cost = stats.costUsd;
  // Empty-content guard: a sub-agent can report subtype=success but emit
  // empty content (e.g., reasoning chain ate the entire output budget at the
  // synthesis turn — observed on K2.6 in r3-r5 and on deepseek-v4-flash in
  // r6b). Treat that as failure so the aggregator's "[Sub-agent N failed]"
  // path engages and fallbackSynthesis has accurate fail counts.
  const subtypeOk = stats.subtype === "success";
  const contentEmpty = (result.content ?? "").trim().length === 0;
  const finalOk = subtypeOk && !contentEmpty;
  const errorReason = !subtypeOk
    ? `subtype=${stats.subtype} halt=${stats.haltReason}`
    : contentEmpty
      ? `subtype=success but empty content (likely reasoning runaway at synthesis turn; outputTokens=${stats.outputTokens})`
      : undefined;
  return {
    index,
    ok: finalOk,
    objective: spec.objective,
    contextIndices: spec.context_indices,
    allowedTools: allowed,
    thinking: spec.thinking,
    iterations: stats.iterations,
    toolCalls: stats.toolCalls,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    ...(stats.cacheHitTokens !== undefined ? { cacheHitTokens: stats.cacheHitTokens } : {}),
    latencyMs: stats.latencyMs,
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(stats.stopReason ? { finishReason: stats.stopReason } : {}),
    ...(errorReason ? { error: errorReason } : {}),
    content: truncate(result.content || "", 12000),
  };
}

// === Stage 3: aggregate ===

async function aggregate(
  client: LlmClient,
  task: string,
  subtasks: SubtaskSpec[],
  agentResults: SwarmAgentResult[],
  parent: SwarmInput,
  signal: AbortSignal,
): Promise<{ raw: LlmCallResult; latencyMs: number } | { error: string; latencyMs: number }> {
  const start = Date.now();
  // K2.6 aggregator over-summarizes by default; bump kimi's min to keep
  // detail-preserving synthesis on multi-axis tasks. r10 showed kimi
  // codebase_explore aggregator hitting max_output_tokens mid-section (b)
  // at 12000 — judge said "truncated mid-sentence... no mention of
  // matrix.ts, routing-eval.ts". 14000 is the conservative bump (r8's
  // 20000 backfired with multi_axis crashing to 23 from over-elaboration);
  // 14000 buys 2k more synthesis room while staying below the over-
  // elaboration regime. Other providers keep the 4000 floor.
  const aggregateMinTokens = client.provider === "kimi" ? 14000 : DEFAULT_AGGREGATE_MIN_TOKENS;
  let raw: LlmCallResult;
  try {
    raw = await client.call({
      systemPrompt: SYSTEM_PROMPTS.swarm_aggregator,
      userPrompt: buildAggregatorPrompt(task, subtasks, agentResults, parent.format),
      maxOutputTokens: reasoningFloor(
        parent.model,
        parent.thinking,
        Math.max(parent.maxOutputTokens, aggregateMinTokens),
      ),
      thinking: parent.thinking,
      format: parent.format,
      model: parent.model,
    });
  } catch (err) {
    if (signal.aborted) {
      return { error: "aggregate aborted (wall_cap)", latencyMs: Date.now() - start };
    }
    const msg = err instanceof LlmError || err instanceof Error ? err.message : String(err);
    return { error: `aggregate call failed: ${msg}`, latencyMs: Date.now() - start };
  }
  return { raw, latencyMs: Date.now() - start };
}

// === Top-level ===

export async function runSwarmLoop(client: LlmClient, input: SwarmInput): Promise<SwarmResult> {
  const provider = client.provider;
  const startedAt = Date.now();
  const wallMs = input.wallTimeMs ?? DEFAULT_WALL_MS;
  const wallController = new AbortController();
  const wallTimer = setTimeout(() => wallController.abort(), wallMs);

  const subagentModel = input.subagentModel ?? SUBAGENT_DEFAULT_MODEL[provider];
  const traceFile = await openTraceFile(provider);
  await appendTrace(traceFile, {
    kind: "user_task",
    task: input.task,
    numAgentsRequested: input.numAgents,
    ts: Date.now(),
  });

  // Aggregated counters
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheHitTokens = 0;
  let haltReason: SwarmHaltReason = "stop";
  let agents: SwarmAgentResult[] = [];
  let subtasks: SubtaskSpec[] = [];
  let decomposeStats = {
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    retries: 0,
    costUsd: undefined as number | undefined,
  };
  let aggregateStats = {
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    costUsd: undefined as number | undefined,
  };
  let finalContent = "[swarm produced no final content]";

  try {
    // === Stage 1: decompose ===
    const t0 = Date.now();
    const dec = await decompose(client, input, wallController.signal, traceFile);
    if ("error" in dec) {
      decomposeStats.latencyMs = dec.latencyMs;
      decomposeStats.retries = dec.retries;
      await appendTrace(traceFile, {
        kind: "decompose_failed",
        reason: dec.error,
        retries: dec.retries,
        latencyMs: dec.latencyMs,
        ts: Date.now(),
      });
      haltReason = "decompose_failed";
      finalContent = `[swarm error] decomposition failed: ${dec.error}`;
      return finalize();
    }
    const decomposeLatency = Date.now() - t0;
    subtasks = dec.result.subtasks;
    decomposeStats = {
      inputTokens: dec.raw.inputTokens,
      outputTokens: dec.raw.outputTokens,
      latencyMs: decomposeLatency,
      retries: dec.retries,
      costUsd: estimateCostUsd(
        provider,
        input.model,
        dec.raw.inputTokens,
        dec.raw.outputTokens,
        dec.raw.cacheHitTokens,
      ),
    };
    totalInputTokens += dec.raw.inputTokens;
    totalOutputTokens += dec.raw.outputTokens;
    if (dec.raw.cacheHitTokens) totalCacheHitTokens += dec.raw.cacheHitTokens;
    await appendTrace(traceFile, {
      kind: "decompose_complete",
      subtasks,
      retries: dec.retries,
      inputTokens: dec.raw.inputTokens,
      outputTokens: dec.raw.outputTokens,
      latencyMs: decomposeLatency,
      ts: Date.now(),
    });

    // === Stage 2: fan out ===
    const numAgents = subtasks.length;
    const perAgentBudget = perAgentBudgetUsd(input.maxBudgetUsd, numAgents);

    // Surface stderr progress like the matrix harness does.
    process.stderr.write(`[swarm] decomposed into ${numAgents} sub-agent(s) — fanning out\n`);

    const fanoutPromises = subtasks.map((spec, idx) =>
      (async () => {
        await appendTrace(traceFile, {
          kind: "subagent_start",
          index: idx + 1,
          objective: spec.objective,
          allowedTools: spec.allowed_tools,
          ts: Date.now(),
        });
        const result = await runOneSubAgent(
          client,
          input,
          spec,
          idx + 1,
          wallController.signal,
          perAgentBudget,
        );
        await appendTrace(traceFile, {
          kind: "subagent_complete",
          index: idx + 1,
          ok: result.ok,
          ...(result.finishReason ? { finishReason: result.finishReason } : {}),
          iterations: result.iterations,
          toolCalls: result.toolCalls,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs: result.latencyMs,
          ...(result.error ? { error: result.error } : {}),
          ts: Date.now(),
        });
        process.stderr.write(
          `[swarm]   sub-agent ${idx + 1}/${numAgents}: ${result.ok ? "ok" : `failed (${result.error ?? "?"})`} (${result.latencyMs}ms, iters=${result.iterations})\n`,
        );
        return result;
      })(),
    );
    const settled = await Promise.allSettled(fanoutPromises);
    agents = settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      return {
        index: i + 1,
        ok: false,
        objective: subtasks[i]?.objective ?? "",
        contextIndices: subtasks[i]?.context_indices ?? [],
        allowedTools: subtasks[i]?.allowed_tools ?? [],
        thinking: subtasks[i]?.thinking ?? false,
        iterations: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        content: "",
      };
    });

    for (const a of agents) {
      totalInputTokens += a.inputTokens;
      totalOutputTokens += a.outputTokens;
      if (a.cacheHitTokens) totalCacheHitTokens += a.cacheHitTokens;
    }

    if (wallController.signal.aborted) {
      haltReason = "wall_cap";
    }

    const okCount = agents.filter((a) => a.ok).length;
    if (okCount === 0) {
      haltReason = "all_subagents_failed";
      finalContent =
        "[swarm error] every sub-agent failed; nothing to aggregate.\n\nSub-agent errors:\n" +
        agents.map((a) => `  [${a.index}] ${a.error ?? "unknown"}`).join("\n");
      return finalize();
    }

    // === Stage 3: aggregate ===
    process.stderr.write(`[swarm] aggregating ${okCount}/${numAgents} ok sub-agent(s)\n`);
    const agg = await aggregate(client, input.task, subtasks, agents, input, wallController.signal);
    if ("error" in agg) {
      aggregateStats.latencyMs = agg.latencyMs;
      haltReason = "aggregate_failed";
      // Provide a usable fallback synthesis from raw sub-agent content.
      finalContent = fallbackSynthesis(input.task, agents, agg.error);
      return finalize();
    }
    aggregateStats = {
      inputTokens: agg.raw.inputTokens,
      outputTokens: agg.raw.outputTokens,
      latencyMs: agg.latencyMs,
      costUsd: estimateCostUsd(
        provider,
        input.model,
        agg.raw.inputTokens,
        agg.raw.outputTokens,
        agg.raw.cacheHitTokens,
      ),
    };
    totalInputTokens += agg.raw.inputTokens;
    totalOutputTokens += agg.raw.outputTokens;
    if (agg.raw.cacheHitTokens) totalCacheHitTokens += agg.raw.cacheHitTokens;
    await appendTrace(traceFile, {
      kind: "aggregate_complete",
      finalContentChars: agg.raw.content.length,
      inputTokens: agg.raw.inputTokens,
      outputTokens: agg.raw.outputTokens,
      latencyMs: agg.latencyMs,
      ts: Date.now(),
    });
    // Empty-content detection: K2.6 thinking-on can burn the entire token
    // budget on hidden reasoning and emit nothing. The call succeeds (we have
    // stats and billing), but the content is unusable. Treat this as an
    // aggregator failure and fall through to the synthesized-from-sub-agents
    // fallback rather than passing "[aggregator returned empty content]" to
    // the caller.
    const aggContent = agg.raw.content?.trim() ?? "";
    if (aggContent.length === 0) {
      haltReason = "aggregate_failed";
      finalContent = fallbackSynthesis(
        input.task,
        agents,
        `aggregator returned empty content (likely reasoning runaway burned the token budget; reasoning=${agg.raw.reasoningContent?.length ?? 0}ch)`,
      );
      process.stderr.write(
        `[swarm] aggregator returned empty content — falling back to raw sub-agent synthesis\n`,
      );
      return finalize();
    }
    finalContent = agg.raw.content;
    haltReason = wallController.signal.aborted ? "wall_cap" : "stop";
    return finalize();
  } finally {
    clearTimeout(wallTimer);
  }

  // ----- helpers (closure-scoped to share the locals above) -----
  function finalize(): SwarmResult {
    const wallElapsed = Date.now() - startedAt;
    const ok = agents.filter((a) => a.ok).length;
    const failed = agents.length - ok;
    const fanoutInput = agents.reduce((s, a) => s + a.inputTokens, 0);
    const fanoutOutput = agents.reduce((s, a) => s + a.outputTokens, 0);
    const fanoutMaxLat = agents.reduce((m, a) => Math.max(m, a.latencyMs), 0);
    const fanoutTotalIter = agents.reduce((s, a) => s + a.iterations, 0);
    const fanoutTotalToolCalls = agents.reduce((s, a) => s + a.toolCalls, 0);
    const fanoutCost = agents.reduce<number | undefined>((s, a) => {
      if (s === undefined && a.costUsd === undefined) return undefined;
      return (s ?? 0) + (a.costUsd ?? 0);
    }, undefined);
    const totalCost =
      (decomposeStats.costUsd ?? 0) + (aggregateStats.costUsd ?? 0) + (fanoutCost ?? 0);

    const stats: SwarmStats = {
      provider,
      models: { coordinator: input.model, aggregator: input.model, subagent: subagentModel },
      num_agents: agents.length,
      totals: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheHitTokens: totalCacheHitTokens,
        costUsd: totalCost,
        wallMs: wallElapsed,
      },
      per_stage: {
        decompose: {
          inputTokens: decomposeStats.inputTokens,
          outputTokens: decomposeStats.outputTokens,
          latencyMs: decomposeStats.latencyMs,
          retries: decomposeStats.retries,
          ...(decomposeStats.costUsd !== undefined ? { costUsd: decomposeStats.costUsd } : {}),
        },
        fanout: {
          agents: agents.length,
          ok,
          failed,
          max_latency_ms: fanoutMaxLat,
          total_input_tokens: fanoutInput,
          total_output_tokens: fanoutOutput,
          ...(fanoutCost !== undefined ? { total_cost_usd: fanoutCost } : {}),
          total_iterations: fanoutTotalIter,
          total_tool_calls: fanoutTotalToolCalls,
        },
        aggregate: {
          inputTokens: aggregateStats.inputTokens,
          outputTokens: aggregateStats.outputTokens,
          latencyMs: aggregateStats.latencyMs,
          ...(aggregateStats.costUsd !== undefined ? { costUsd: aggregateStats.costUsd } : {}),
        },
      },
      agents,
      haltReason,
      ...(traceFile ? { tracePath: traceFile } : {}),
    };
    void appendTrace(traceFile, { kind: "halt", reason: haltReason, ts: Date.now() });
    return { content: finalContent, stats };
  }
}

function fallbackSynthesis(task: string, agents: SwarmAgentResult[], aggError: string): string {
  const lines = [
    `[swarm] aggregator failed (${aggError}); returning raw sub-agent outputs.`,
    "",
    `Original task: ${task}`,
    "",
    "## Sub-agent outputs (raw, no synthesis)",
    "",
  ];
  for (const a of agents) {
    lines.push(`### Sub-agent ${a.index} — ${a.ok ? "ok" : `FAILED (${a.error})`}`);
    lines.push(`Objective: ${a.objective}`);
    lines.push("");
    if (a.ok) {
      lines.push(a.content || "[empty]");
    }
    lines.push("");
  }
  return lines.join("\n");
}
