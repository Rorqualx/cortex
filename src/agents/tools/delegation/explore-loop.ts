// ReAct loop for the *__explore tools (one per provider). The model is given
// the user's task plus up to 10 tools (6 read-only: list_dir, read_file, glob,
// grep, web_fetch, web_search; 4 mutating: write_file, write_files,
// notebook_edit, bash) and iterates until it has enough information to answer
// or hits a cap. The system prompt is built dynamically based on (a) the
// active provider — DeepSeek gets a "one tool at a time" steer because
// parallel tool calls aren't documented as supported there — and (b) whether
// the active toolset (after allowed/disallowed filtering) contains any
// mutating tools.
//
// The loop runs entirely server-side: Opus calls the MCP tool, gets back a
// single final synthesis, and never sees the iteration trace. This is the
// property haiku-class subagents have that the stateless single-completion
// tools don't.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXPLORE_TOOL_DEFS,
  EXPLORE_TOOL_NAMES,
  executeExploreTool,
  isReadOnlyTool,
  type ExploreToolName,
} from "./explore-tools.js";
import { getPreToolHookCommand, getStopHookCommand, runPreToolHook, runStopHook } from "./hooks.js";
import { estimateCostUsd } from "./pricing.js";
import type {
  ChatMessage,
  LlmCallResult,
  LlmClient,
  Provider,
  ToolCall,
  ToolDef,
} from "./providers/types.js";
import type { ExtraTool, ExtraToolCtx, ExtraToolResult } from "./swarm-v2-types.js";

// Native general-purpose subagents have no fixed maxTurns the caller sees —
// they run until the model converges, the wall budget elapses, or output
// budget is exhausted. To match that behavior, the primary "you're done"
// signal here is the no-progress detector below (with wall + bytes as the
// outer safety net); the integer iter cap is kept only as a DoS ceiling.
// 50 is a generous soft default — well-behaved loops finish on no-progress
// long before reaching it.
const DEFAULT_MAX_ITERATIONS = 50;
// 600s wall + 4MB byte cap give the loop room to do real cross-file work
// (the kind that previously triggered the Sonnet-bypass) while still bounding
// runaway behavior. Schema enforces wall<=30min, bytes<=10MB as ceilings.
const DEFAULT_WALL_MS = 600_000;
const DEFAULT_MAX_TOTAL_TOOL_BYTES = 4_000_000;
const HARD_MAX_ITERATIONS = 200;
// Synthesis reserve. The wall is the ONLY cap that, left raw, hard-aborts the
// loop mid-tool-call — leaving finalContent as the model's last mid-reasoning
// message instead of an answer (every other cap pushes a "write your answer
// now" note + forces a synthesis turn first). We stop *exploring* this far
// before the hard wall so the model still gets one forced synthesis turn within
// budget. Fraction of the BINDING budget (min of own + shared wall) with a
// floor, capped at half that budget so a tiny wall still keeps room to explore.
const WALL_SYNTH_RESERVE_FRACTION = 0.08;
const WALL_SYNTH_RESERVE_MIN_MS = 45_000;
const DEFAULT_FRESH_WINDOW_SIZE = 8;
const COMPACTED_BYTE_CAP = 400;
// No-progress halt: if the last NO_PROGRESS_WINDOW iterations introduced zero
// novel (tool_name, arguments) signatures AND ingested fewer than
// NO_PROGRESS_BYTE_THRESHOLD bytes of new tool output combined, the model has
// stalled — trigger synthesis instead of letting it spin to the iter cap. A
// repeated read with widening line ranges has different args (different sig),
// so legitimate progressive exploration is not penalized.
const NO_PROGRESS_WINDOW = 3;
const NO_PROGRESS_BYTE_THRESHOLD = 256;

function buildSystemPrompt(provider: Provider, hasMutatingTools: boolean): string {
  // DeepSeek doesn't document parallel tool calls; the safer steer is to
  // sequence them across iterations. Z.ai/Kimi handle multi-tool turns fine.
  const parallelLine =
    provider === "deepseek"
      ? "  4. Call ONE tool per turn — this provider sequences tool calls best across iterations rather than in parallel batches."
      : "  4. When multiple independent reads are needed, call them ALL in a single turn — they execute in parallel, saving wall-clock time.";

  const lines = [
    hasMutatingTools
      ? "You are a code assistant working inside a sandboxed environment with read AND write access."
      : "You are a code explorer working inside a sandboxed read-only environment.",
    "Use the provided tools to investigate the codebase and answer the user's task.",
    "",
    "Strategy:",
    "  1. Start by listing the search root(s) (list_dir) to see the layout.",
    "  2. Use glob to find files by pattern, grep to find content matches.",
    "  3. Read specific files (or line slices) only when you need details — prefer grep for finding usages.",
    parallelLine,
    "  5. When you have enough information, STOP calling tools and write a concise final answer.",
    "",
    "Constraints:",
    "  - All paths must be absolute and inside the allowed roots provided in the user's task.",
  ];
  if (hasMutatingTools) {
    lines.push(
      "  - You can write files (write_file, plus append:true to add to end without overwriting; write_files for batches up to 20), edit Jupyter notebooks cell-aware (notebook_edit), and run shell commands (bash). Use bash for tasks that are more efficient as one-liners (seq/printf to generate patterned files, tsc/jest/git to verify your work). Bash is shell:false — no pipes, redirects, or command substitution; sequence multiple bash calls instead.",
      "  - You can fetch URLs (web_fetch — http/https only, private/loopback hosts blocked, body capped) and search the web (web_search — counts against your monthly MCP quota; use for fresh facts that aren't in the codebase).",
    );
  } else {
    lines.push(
      "  - You CANNOT edit, write, run shell commands, or fetch URLs. Read-only filesystem access only.",
    );
  }
  lines.push(
    "  - Each tool result is capped; if a file is huge, use line ranges or grep instead of reading whole files.",
    "  - Older tool results may be auto-compacted to a one-line summary to keep context manageable; extract what you need from each result on the iteration after you read it, rather than relying on raw outputs from many iterations ago.",
    "  - The user only sees your final message — make it self-contained and complete.",
  );
  return lines.join("\n");
}

export type ExploreInput = {
  task: string;
  roots: string[];
  contextItems?: string[] | undefined;
  filePaths?: string[] | undefined;
  model: string;
  thinking: boolean;
  format: "text" | "markdown" | "json";
  maxIterations?: number;
  maxOutputTokens: number;
  // Per-call budget overrides. When undefined, the loop falls back to the
  // MCP_EXPLORE_* env vars; when those are also unset, hardcoded defaults
  // apply (DEFAULT_WALL_MS, DEFAULT_MAX_TOTAL_TOOL_BYTES, no spend cap).
  wallTimeMs?: number | undefined;
  maxTotalToolBytes?: number | undefined;
  maxBudgetUsd?: number | undefined;
  trace?: boolean;
  // Native-style tool gating. allowedTools (whitelist) is applied first,
  // then disallowedTools (blacklist) — disallow always wins.
  allowedTools?: ExploreToolName[] | undefined;
  disallowedTools?: ExploreToolName[] | undefined;
  // === v2 swarm hooks (additive; default empty/undefined = byte-identical v1 behavior) ===
  // Extra tools merged into the catalog at definition-build time. v2's
  // `spawn_subagents` lives here. Names must not collide with EXPLORE_TOOL_NAMES;
  // collision throws at merge time. See swarm-v2-types.ts for the ExtraTool shape.
  extraTools?: ExtraTool[] | undefined;
  // External wall-clock signal that fires when the parent swarm's wall budget
  // expires. The loop's own wall timer still applies; this is OR'd with it.
  wallSignal?: AbortSignal | undefined;
  // Absolute epoch-ms deadline of the external wall (the moment wallSignal
  // fires). Lets the loop reserve synthesis time against whichever deadline —
  // its own or the shared swarm wall — binds FIRST. Without it, a late-spawned
  // sub-agent would compute its synthesis reserve against its own (far-future)
  // wall and still hard-abort when the shared wall fires. Omitted by standalone
  // explore tools (no external wall) → reserve falls back to the own wall only.
  wallDeadlineMs?: number | undefined;
  // Optional ctx fields passed to extra-tool handlers. Used by v2 to thread
  // releaseParentSlot/reacquireParentSlot from the spawning agent's
  // semaphore-acquisition site down to the spawn_subagents handler.
  extraToolCtx?: Pick<ExtraToolCtx, "releaseParentSlot" | "reacquireParentSlot"> | undefined;
  // Optional appendix appended to the auto-built system prompt. Used by v2
  // to inject the CEO directives ("you are an orchestrator...") on top of
  // the standard explore-loop system prompt.
  systemPromptAppendix?: string | undefined;
};

// Re-exported for downstream callers (the actual definitions live in
// swarm-v2-types.ts; explore-loop only consumes the types, never the impl).
export type { ExtraTool, ExtraToolCtx, ExtraToolResult } from "./swarm-v2-types.js";

export class EmptyToolsetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyToolsetError";
  }
}

/**
 * Compute the active tool set after applying allowed/disallowed filters.
 * Returns the filtered EXPLORE_TOOL_DEFS plus a Set of names for fast
 * defensive checks at execution time.
 */
function resolveActiveTools(
  allowed: readonly ExploreToolName[] | undefined,
  disallowed: readonly ExploreToolName[] | undefined,
): { defs: readonly ToolDef[]; nameSet: Set<string> } {
  const allowSet = allowed && allowed.length > 0 ? new Set<string>(allowed) : null;
  const denySet = disallowed && disallowed.length > 0 ? new Set<string>(disallowed) : null;

  const filtered: ToolDef[] = EXPLORE_TOOL_DEFS.filter((def) => {
    if (allowSet && !allowSet.has(def.function.name)) return false;
    if (denySet && denySet.has(def.function.name)) return false;
    return true;
  });

  if (filtered.length === 0) {
    const inputs = `allowed=${allowed ? `[${allowed.join(",")}]` : "<none>"} disallowed=${disallowed ? `[${disallowed.join(",")}]` : "<none>"}`;
    throw new EmptyToolsetError(
      `allowed_tools/disallowed_tools filtered the explore toolset to empty (${inputs}). ` +
        `Available tools: ${EXPLORE_TOOL_NAMES.join(", ")}.`,
    );
  }

  return {
    defs: filtered,
    nameSet: new Set(filtered.map((d) => d.function.name)),
  };
}

// Native SDK ResultMessage.subtype parity. Maps the loop's haltReason onto
// the same vocabulary native callers already pattern-match against.
export type ExploreSubtype =
  | "success"
  | "error_max_turns"
  | "error_max_wall_clock"
  | "error_max_tool_bytes"
  | "error_max_budget_usd"
  | "error_during_execution";

export type ToolTiming = {
  name: string;
  count: number;
  totalMs: number;
};

export type ExploreStats = {
  provider: Provider;
  iterations: number;
  toolCalls: number;
  totalToolBytes: number;
  compactedToolResults: number;
  latencyMs: number;
  modelLatencyMs: number;
  toolLatencyMs: number;
  toolBreakdown: ToolTiming[];
  hooks?: {
    invocations: number;
    denied: number;
    totalMs: number;
  };
  model: string;
  inputTokens: number;
  outputTokens: number;
  // Cache-hit input tokens summed across all iterations. Omitted when the
  // provider doesn't surface cache fields (Z.ai today) or no hits occurred.
  cacheHitTokens?: number;
  haltReason:
    | "stop"
    | "iter_cap"
    | "wall_cap"
    | "byte_cap"
    | "budget_cap"
    | "no_progress"
    | "no_tool_calls"
    | "error";
  stopReason?: string;
  subtype: ExploreSubtype;
  // Estimated PaaS-tier cost in USD. Omitted when the (provider, model) pair
  // isn't in pricing.ts. Note: Coding-Plan / membership-plan callers don't pay
  // per-token — this is an efficiency estimate, not a bill.
  costUsd?: number;
  tracePath?: string;
};

function haltReasonToSubtype(halt: ExploreStats["haltReason"]): ExploreSubtype {
  switch (halt) {
    case "stop":
    case "no_tool_calls":
    case "no_progress":
      // Convergence — the model stopped finding new information. Treat as
      // success (the synthesis turn produced a real answer), not an error.
      return "success";
    case "iter_cap":
      return "error_max_turns";
    case "wall_cap":
      return "error_max_wall_clock";
    case "byte_cap":
      return "error_max_tool_bytes";
    case "budget_cap":
      return "error_max_budget_usd";
    case "error":
      return "error_during_execution";
  }
}

export type ExploreResult = {
  content: string;
  stats: ExploreStats;
};

type TraceEvent =
  | { kind: "user_task"; text: string; roots: string[]; ts: number }
  | {
      kind: "llm_response";
      iter: number;
      finish: string | undefined;
      content: string;
      toolCalls: ToolCall[];
      latencyMs: number;
      ts: number;
    }
  | { kind: "tool_call"; iter: number; name: string; arguments: string; ts: number }
  | { kind: "tool_result"; iter: number; name: string; bytes: number; preview: string; ts: number }
  | {
      kind: "compacted";
      iter: number;
      name: string;
      bytesBefore: number;
      bytesAfter: number;
      ts: number;
    }
  | { kind: "halt"; reason: string; ts: number };

async function appendTrace(traceFile: string | null, event: TraceEvent): Promise<void> {
  if (!traceFile) return;
  try {
    await fs.appendFile(traceFile, JSON.stringify(event) + "\n");
  } catch {
    // tracing must not affect correctness
  }
}

async function openTraceFile(provider: Provider): Promise<string | null> {
  if (process.env["MCP_EXPLORE_TRACE"] !== "1") return null;
  const dir = path.join(os.homedir(), ".claude", "mcp-explore-trace", provider);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    return null;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${ts}.jsonl`);
}

function buildInitialUserPrompt(input: ExploreInput): string {
  const lines: string[] = [];
  lines.push(`Task: ${input.task}`);
  lines.push("");
  lines.push("Allowed search roots (use these as `root`/`path` arguments to tools):");
  for (const r of input.roots) lines.push(`  - ${r}`);
  if (input.contextItems && input.contextItems.length > 0) {
    lines.push("");
    lines.push("Pre-supplied context (already loaded for you):");
    for (let i = 0; i < input.contextItems.length; i++) {
      lines.push(`--- context[${i}] ---`);
      lines.push(input.contextItems[i] ?? "");
    }
  }
  if (input.filePaths && input.filePaths.length > 0) {
    lines.push("");
    lines.push(
      "Seed files the user pre-selected (you may read them or use them as starting points):",
    );
    for (const p of input.filePaths) lines.push(`  - ${p}`);
  }
  lines.push("");
  lines.push(
    "Begin by exploring the roots. When you have enough to answer the task, write your final response without calling any more tools.",
  );
  return lines.join("\n");
}

function parseToolArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function previewBytes(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

// Compact a tool result message in place. See module note on compaction.
export function compactToolResult(toolName: string, content: string): string {
  const lines = content.split("\n");
  const firstLine = (lines[0] ?? "").trim();
  const header = firstLine.startsWith("# ") ? firstLine.slice(2) : firstLine;

  let body = "";
  if (toolName === "read_file") {
    const firstContentLine = lines.slice(1).find((l) => l.trim().length > 0);
    if (firstContentLine) body = ` → first: ${firstContentLine.trim().slice(0, 120)}`;
  }

  const compacted = `[compacted: ${toolName} ${header}${body}]`;
  if (compacted.length <= COMPACTED_BYTE_CAP) return compacted;
  return compacted.slice(0, COMPACTED_BYTE_CAP - 1) + "]";
}

export async function runExploreLoop(
  client: LlmClient,
  input: ExploreInput,
): Promise<ExploreResult> {
  const provider = client.provider;
  const startedAt = Date.now();
  const maxIter = Math.min(input.maxIterations ?? DEFAULT_MAX_ITERATIONS, HARD_MAX_ITERATIONS);
  const wallMs = input.wallTimeMs ?? Number(process.env["MCP_EXPLORE_WALL_MS"] ?? DEFAULT_WALL_MS);
  const maxTotalToolBytes =
    input.maxTotalToolBytes ??
    Number(process.env["MCP_EXPLORE_MAX_TOOL_BYTES"] ?? DEFAULT_MAX_TOTAL_TOOL_BYTES);

  const { defs: builtInDefs, nameSet: builtInNames } = resolveActiveTools(
    input.allowedTools,
    input.disallowedTools,
  );

  // Merge in extra tools (v2's spawn_subagents lives here). Names must not
  // collide with built-ins. Default empty array → byte-identical v1 behavior.
  const extraTools: ExtraTool[] = input.extraTools ?? [];
  for (const et of extraTools) {
    if (builtInNames.has(et.name)) {
      throw new Error(
        `extraTools[].name collides with built-in tool: ${et.name}. Rename the extra tool.`,
      );
    }
  }
  const extraDefs = extraTools.map((et) => et.definition);
  const extraByName = new Map<string, ExtraTool>(extraTools.map((et) => [et.name, et]));
  const activeToolDefs = [...builtInDefs, ...extraDefs];
  const activeToolNames = new Set<string>([...builtInNames, ...extraByName.keys()]);

  const traceFile = await openTraceFile(provider);
  await appendTrace(traceFile, {
    kind: "user_task",
    text: input.task,
    roots: input.roots,
    ts: Date.now(),
  });

  const wallController = new AbortController();
  const wallTimer = setTimeout(() => wallController.abort(), wallMs);
  // External wall signal (e.g. parent swarm's root wall). When it fires,
  // we abort our own wallController so the in-flight chat call exits and
  // the loop's halt logic registers wall_cap.
  const externalAbortHandler = () => wallController.abort();
  if (input.wallSignal) {
    if (input.wallSignal.aborted) wallController.abort();
    else input.wallSignal.addEventListener("abort", externalAbortHandler, { once: true });
  }

  const hasMutatingTools = [...activeToolNames].some((n) => !isReadOnlyTool(n));
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: input.systemPromptAppendix
        ? buildSystemPrompt(provider, hasMutatingTools) + "\n\n" + input.systemPromptAppendix
        : buildSystemPrompt(provider, hasMutatingTools),
    },
    { role: "user", content: buildInitialUserPrompt(input) },
  ];

  let iterations = 0;
  let totalToolCalls = 0;
  let totalToolBytes = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheHitTokens = 0;
  let totalModelLatencyMs = 0;
  let totalToolLatencyMs = 0;
  let capFired = false;
  const toolTimings = new Map<string, { count: number; totalMs: number }>();
  const hookCmd = getPreToolHookCommand();
  let hookInvocations = 0;
  let hookDenied = 0;
  let hookTotalMs = 0;
  let finalContent = "";
  let haltReason: ExploreStats["haltReason"] = "stop";
  let lastModel = input.model;
  let lastFinishReason: string | undefined;
  let compactedCount = 0;
  const recentToolMsgs: Array<{ idx: number; toolName: string }> = [];
  const freshWindow = Math.max(
    1,
    Math.min(Number(process.env["MCP_EXPLORE_FRESH_WINDOW"] ?? DEFAULT_FRESH_WINDOW_SIZE), 50),
  );
  // No-progress tracker state. seenSignatures is a permanent set of
  // (tool_name, raw arguments) pairs the loop has executed. turnNovelCounts
  // and turnNewBytes are per-iteration; only the last NO_PROGRESS_WINDOW
  // entries are inspected, but we keep the full vectors for trace/debug.
  const seenSignatures = new Set<string>();
  const turnNovelCounts: number[] = [];
  const turnNewBytes: number[] = [];

  // Hard deadline = the EARLIER of this loop's own wall and the external
  // (shared swarm) wall. The synthesis reserve is sized against the budget
  // remaining until that binding deadline, so a late-spawned sub-agent bound by
  // the shared wall still stops to synthesize before it fires.
  const ownDeadline = startedAt + wallMs;
  const hardDeadline =
    input.wallDeadlineMs !== undefined ? Math.min(ownDeadline, input.wallDeadlineMs) : ownDeadline;
  const bindingBudgetMs = Math.max(0, hardDeadline - startedAt);
  const synthReserveMs = Math.min(
    Math.max(bindingBudgetMs * WALL_SYNTH_RESERVE_FRACTION, WALL_SYNTH_RESERVE_MIN_MS),
    bindingBudgetMs * 0.5,
  );
  const softDeadline = hardDeadline - synthReserveMs;
  // True iff the loop ended via the soft-wall synthesis turn (vs. a clean stop
  // or the iter cap). Lets us report wall_cap honestly after the forced turn.
  let wallSynthesisForced = false;

  while (iterations < maxIter) {
    const now = Date.now();
    if (now >= hardDeadline) {
      // Hard wall: a tool batch or chat turn overran the synthesis reserve.
      // finalContent holds whatever the last turn produced; swarm-v2's
      // adjudicator treats this (wall_cap + aborted signal) as untrustworthy
      // and falls back to raw sub-agent output.
      haltReason = "wall_cap";
      break;
    }
    iterations++;
    // Force a synthesis turn when iterations are exhausted OR we've crossed the
    // soft deadline (entered the reserve window). Both must end the loop with a
    // real answer, never a mid-reasoning fragment.
    const softWallHit = now >= softDeadline;
    if (softWallHit) wallSynthesisForced = true;
    const isFinalIter = iterations === maxIter || softWallHit;

    if (isFinalIter) {
      const limitClause =
        iterations === maxIter
          ? `You have used ${iterations - 1} of ${maxIter} iterations`
          : `You are out of wall-clock time for exploration`;
      messages.push({
        role: "user",
        content:
          `[system note] ${limitClause} and ` +
          `CANNOT call any more tools — the exploration phase is over. Based on the tool ` +
          `results above, write your final answer now using what you've already gathered. ` +
          `If your investigation is incomplete, explicitly state which parts are partial ` +
          `and give your best answer for the parts you did cover. Do NOT output tool-call ` +
          `syntax (e.g. <tool_call>...</tool_call>) — it will not be executed. Synthesize, ` +
          `don't request.`,
      });
    }

    let result: LlmCallResult;
    try {
      // r13 tested forcing thinking=false at the final synthesis iter for
      // kimi (theory: K2.6's reasoning_content was eating max_output_tokens
      // before content emerged, causing empty-content events). Result: same
      // sub-agent failure rate (1/3 still failed at iter_cap), but failure
      // shape changed from "subtype=success but empty content" to
      // "subtype=error_max_turns" — so K2.6 with thinking=false at the
      // synthesis turn doesn't emit content either, it just halts
      // differently. Reverted; the kimi 75 ceiling on codebase_explore
      // appears intrinsic to K2.6 behavior at this complexity, not
      // addressable through synthesis-turn thinking flags.
      result = await client.chat({
        messages,
        model: input.model,
        maxOutputTokens: input.maxOutputTokens,
        // Let the provider apply its own default — Z.ai/Kimi force 1.0 on
        // thinking, DeepSeek omits the field entirely under thinking.
        temperature: undefined,
        thinking: input.thinking,
        tools: activeToolDefs,
        toolChoice: isFinalIter ? "none" : "auto",
        signal: wallController.signal,
      });
    } catch (err) {
      if (wallController.signal.aborted) {
        haltReason = "wall_cap";
        await appendTrace(traceFile, {
          kind: "halt",
          reason: "wall_cap (mid-call abort)",
          ts: Date.now(),
        });
        break;
      }
      haltReason = "error";
      finalContent = `[explore error] ${(err as Error).message}`;
      await appendTrace(traceFile, {
        kind: "halt",
        reason: `error: ${(err as Error).message}`,
        ts: Date.now(),
      });
      break;
    }

    lastModel = result.model;
    lastFinishReason = result.finishReason;
    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;
    totalCacheHitTokens += result.cacheHitTokens ?? 0;
    totalModelLatencyMs += result.latencyMs;
    finalContent = result.content || finalContent;

    await appendTrace(traceFile, {
      kind: "llm_response",
      iter: iterations,
      finish: result.finishReason,
      content: previewBytes(result.content, 500),
      toolCalls: result.toolCalls ?? [],
      latencyMs: result.latencyMs,
      ts: Date.now(),
    });

    const toolCalls = result.toolCalls ?? [];
    if (toolCalls.length === 0) {
      if (!capFired) {
        haltReason = result.finishReason === "stop" ? "stop" : "no_tool_calls";
      }
      break;
    }

    // Record the assistant turn (with tool_calls + reasoning_content if the
    // provider surfaced any) BEFORE executing them. DeepSeek requires
    // reasoning_content to round-trip on assistant messages whenever any
    // tool_call exists in the conversation; the provider client strips it
    // when the rule says to. For other providers reasoning_content is benign.
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: result.content || null,
      tool_calls: toolCalls,
    };
    if (result.reasoningContent) {
      assistantMsg.reasoning_content = result.reasoningContent;
    }
    messages.push(assistantMsg);

    let hitByteCap = false;
    totalToolCalls += toolCalls.length;

    for (const call of toolCalls) {
      await appendTrace(traceFile, {
        kind: "tool_call",
        iter: iterations,
        name: call.function.name,
        arguments: previewBytes(call.function.arguments, 500),
        ts: Date.now(),
      });
    }

    const currentIter = iterations;
    const executeOne = async (call: (typeof toolCalls)[number]): Promise<string> => {
      const args = parseToolArgs(call.function.arguments);
      const callStart = Date.now();
      let output: string;
      if (args === null) {
        output = `error: arguments were not valid JSON: ${call.function.arguments.slice(0, 200)}`;
      } else if (!activeToolNames.has(call.function.name)) {
        output = `error: tool '${call.function.name}' is not in the allowed set for this run (allowed: ${[...activeToolNames].join(", ")})`;
      } else if (extraByName.has(call.function.name)) {
        // Extra tool dispatch (e.g. v2's spawn_subagents). Hooks don't apply
        // to extras since they're not fs/web/bash tools. The tool's handler
        // returns content + optional meta; we surface the content as the
        // tool result and stash meta in the trace.
        const extra = extraByName.get(call.function.name)!;
        const ctx: ExtraToolCtx = {
          signal: wallController.signal,
          iteration: currentIter,
          remainingWallMs: Math.max(0, wallMs - (Date.now() - startedAt)),
          // Slot hooks come from input.extraToolCtx if the caller threaded
          // them; otherwise no-op (CEO use-case at depth 0).
          ...(input.extraToolCtx ?? {}),
        };
        try {
          const res: ExtraToolResult = await extra.handler(args, ctx);
          output = res.content;
          // res.meta is intentionally not traced here — explore-loop's
          // TraceEvent union is closed. Callers (e.g. swarm-v2-loop) can
          // attach their own trace. Reserved for future TraceEvent extension.
          void res.meta;
        } catch (err) {
          output = `[extra_tool error] ${err instanceof Error ? err.message : String(err)}`;
        }
      } else if (hookCmd) {
        const { decision, elapsedMs: hookMs } = await runPreToolHook(hookCmd, {
          tool_name: call.function.name,
          tool_input: args,
          iteration: currentIter,
        });
        hookInvocations++;
        hookTotalMs += hookMs;
        if (decision.decision === "deny") {
          hookDenied++;
          output = `denied by pre-tool hook: ${decision.reason}`;
        } else {
          output = await executeExploreTool(call.function.name, args);
        }
      } else {
        output = await executeExploreTool(call.function.name, args);
      }
      const elapsed = Date.now() - callStart;
      const prev = toolTimings.get(call.function.name);
      if (prev) {
        prev.count++;
        prev.totalMs += elapsed;
      } else {
        toolTimings.set(call.function.name, { count: 1, totalMs: elapsed });
      }
      return output;
    };

    // Parallel only when EVERY tool in the batch is read-only AND the provider
    // is known to handle parallel tool calls. DeepSeek doesn't document
    // parallel-call support, so we sequence its batches even when read-only.
    const allReadOnly =
      provider !== "deepseek" && toolCalls.every((c) => isReadOnlyTool(c.function.name));
    const toolBatchStart = Date.now();
    let outputs: string[];
    if (allReadOnly) {
      outputs = await Promise.all(toolCalls.map(executeOne));
    } else {
      outputs = [];
      for (const call of toolCalls) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequencing
        outputs.push(await executeOne(call));
      }
    }
    totalToolLatencyMs += Date.now() - toolBatchStart;

    let novelThisTurn = 0;
    let newBytesThisTurn = 0;
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]!;
      const toolOutput = outputs[i]!;
      const bytes = Buffer.byteLength(toolOutput, "utf8");
      totalToolBytes += bytes;
      newBytesThisTurn += bytes;
      const sig = `${call.function.name}:${call.function.arguments}`;
      if (!seenSignatures.has(sig)) {
        seenSignatures.add(sig);
        novelThisTurn++;
      }
      await appendTrace(traceFile, {
        kind: "tool_result",
        iter: iterations,
        name: call.function.name,
        bytes,
        preview: previewBytes(toolOutput, 300),
        ts: Date.now(),
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolOutput,
      });
      recentToolMsgs.push({ idx: messages.length - 1, toolName: call.function.name });
    }
    turnNovelCounts.push(novelThisTurn);
    turnNewBytes.push(newBytesThisTurn);
    if (totalToolBytes > maxTotalToolBytes) {
      hitByteCap = true;
    }

    while (recentToolMsgs.length > freshWindow) {
      const stale = recentToolMsgs.shift();
      if (!stale) break;
      const msg = messages[stale.idx];
      if (!msg || msg.role !== "tool" || typeof msg.content !== "string") continue;
      const before = Buffer.byteLength(msg.content, "utf8");
      const compacted = compactToolResult(stale.toolName, msg.content);
      const after = Buffer.byteLength(compacted, "utf8");
      if (after >= before) continue;
      msg.content = compacted;
      compactedCount++;
      await appendTrace(traceFile, {
        kind: "compacted",
        iter: iterations,
        name: stale.toolName,
        bytesBefore: before,
        bytesAfter: after,
        ts: Date.now(),
      });
    }

    if (hitByteCap) {
      messages.push({
        role: "user",
        content: `[system note] You have used ${totalToolBytes} bytes of tool output, exceeding the ${maxTotalToolBytes} byte cap. Stop calling tools and write your final answer based on what you've gathered.`,
      });
      haltReason = "byte_cap";
      capFired = true;
    }

    if (!capFired && turnNovelCounts.length >= NO_PROGRESS_WINDOW) {
      const recentNovel = turnNovelCounts.slice(-NO_PROGRESS_WINDOW).reduce((a, b) => a + b, 0);
      const recentBytes = turnNewBytes.slice(-NO_PROGRESS_WINDOW).reduce((a, b) => a + b, 0);
      if (recentNovel === 0 && recentBytes < NO_PROGRESS_BYTE_THRESHOLD) {
        messages.push({
          role: "user",
          content:
            `[system note] No new information gathered in the last ${NO_PROGRESS_WINDOW} ` +
            `iterations (no novel tool calls, only ${recentBytes} bytes of new output). ` +
            `You appear to have everything you need — stop calling tools and write your ` +
            `final answer based on what you've gathered.`,
        });
        haltReason = "no_progress";
        capFired = true;
      }
    }

    if (!capFired && input.maxBudgetUsd !== undefined) {
      const currentCost = estimateCostUsd(
        provider,
        lastModel,
        totalInputTokens,
        totalOutputTokens,
        totalCacheHitTokens,
      );
      if (currentCost !== undefined && currentCost > input.maxBudgetUsd) {
        messages.push({
          role: "user",
          content:
            `[system note] You have used $${currentCost.toFixed(4)} of $${input.maxBudgetUsd.toFixed(4)} ` +
            `budget. Stop calling tools and write your final answer based on what you've gathered.`,
        });
        haltReason = "budget_cap";
        capFired = true;
      }
    }
  }

  clearTimeout(wallTimer);
  if (input.wallSignal) input.wallSignal.removeEventListener("abort", externalAbortHandler);

  if (iterations >= maxIter && haltReason === "stop") {
    haltReason = "iter_cap";
  } else if (wallSynthesisForced && (haltReason === "stop" || haltReason === "no_tool_calls")) {
    // The loop ended cleanly via the forced soft-wall synthesis turn. Report it
    // as wall_cap (content is a real, if possibly partial, answer) so callers
    // distinguish "converged early" from "stopped because time ran out".
    haltReason = "wall_cap";
  }

  await appendTrace(traceFile, { kind: "halt", reason: haltReason, ts: Date.now() });

  const toolBreakdown: ToolTiming[] = Array.from(toolTimings.entries())
    .map(([name, agg]) => ({ name, count: agg.count, totalMs: agg.totalMs }))
    .sort((a, b) => b.totalMs - a.totalMs);

  const stats: ExploreStats = {
    provider,
    iterations,
    toolCalls: totalToolCalls,
    totalToolBytes,
    compactedToolResults: compactedCount,
    latencyMs: Date.now() - startedAt,
    modelLatencyMs: totalModelLatencyMs,
    toolLatencyMs: totalToolLatencyMs,
    toolBreakdown,
    model: lastModel,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    haltReason,
    subtype: haltReasonToSubtype(haltReason),
  };
  if (totalCacheHitTokens > 0) stats.cacheHitTokens = totalCacheHitTokens;
  if (lastFinishReason) stats.stopReason = lastFinishReason;
  const cost = estimateCostUsd(
    provider,
    lastModel,
    totalInputTokens,
    totalOutputTokens,
    totalCacheHitTokens,
  );
  if (cost !== undefined) stats.costUsd = cost;
  if (hookCmd) {
    stats.hooks = {
      invocations: hookInvocations,
      denied: hookDenied,
      totalMs: hookTotalMs,
    };
  }
  if (traceFile) stats.tracePath = traceFile;

  const stopHookCmd = getStopHookCommand();
  if (stopHookCmd) {
    await runStopHook(stopHookCmd, {
      provider,
      subtype: stats.subtype,
      halt_reason: stats.haltReason,
      iterations: stats.iterations,
      tool_calls: stats.toolCalls,
      tool_breakdown: stats.toolBreakdown,
      latency_ms: stats.latencyMs,
      model_latency_ms: stats.modelLatencyMs,
      tool_latency_ms: stats.toolLatencyMs,
      model: stats.model,
      input_tokens: stats.inputTokens,
      output_tokens: stats.outputTokens,
      ...(stats.cacheHitTokens !== undefined ? { cache_hit_tokens: stats.cacheHitTokens } : {}),
      ...(stats.costUsd !== undefined ? { cost_usd: stats.costUsd } : {}),
      ...(stats.stopReason ? { stop_reason: stats.stopReason } : {}),
      content: finalContent,
    });
  }

  return { content: finalContent, stats };
}
