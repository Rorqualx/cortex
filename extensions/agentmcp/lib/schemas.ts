import { z } from "zod";
import { EXPLORE_TOOL_NAMES } from "./explore-tools.js";
import type { Provider } from "./providers/types.js";

// === Per-provider closed model allowlists ===
//
// Models reachable via /chat/completions on the production endpoint of each
// provider. Verified 2026-05-03. A missing entry means re-probe before adding
// — keep in lockstep with pricing.ts.

const ZAI_TEXT_MODELS = [
  "glm-5.1",
  "glm-5",
  "glm-5-turbo",
  "glm-4.7",
  "glm-4.7-flash",
  "glm-4.6",
  "glm-4.5",
  "glm-4.5-air",
  "glm-4.5-flash",
] as const;

const ZAI_VISION_MODELS = ["glm-4.6v", "glm-4.5v"] as const;

const DEEPSEEK_TEXT_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
// DeepSeek has no vision-capable model on this surface.

const KIMI_TEXT_MODELS = [
  "kimi-k2.6",
  "kimi-k2.5",
  "kimi-k2-thinking",
  "kimi-k2-thinking-turbo",
  "kimi-k2-0905-preview",
  "kimi-k2-0711-preview",
  "kimi-k2-turbo-preview",
  "moonshot-v1-8k",
  "moonshot-v1-32k",
  "moonshot-v1-128k",
] as const;

const KIMI_VISION_MODELS = [
  "kimi-k2.6",
  "kimi-k2.5",
  "moonshot-v1-8k-vision-preview",
  "moonshot-v1-32k-vision-preview",
  "moonshot-v1-128k-vision-preview",
] as const;

const TEXT_MODELS_BY_PROVIDER = {
  zai: ZAI_TEXT_MODELS,
  deepseek: DEEPSEEK_TEXT_MODELS,
  kimi: KIMI_TEXT_MODELS,
} as const;

const VISION_MODELS_BY_PROVIDER = {
  zai: ZAI_VISION_MODELS,
  kimi: KIMI_VISION_MODELS,
} as const;

export type VisionProvider = keyof typeof VISION_MODELS_BY_PROVIDER;

const TEXT_MODEL_HINTS: Record<Provider, string> = {
  zai: "Override default model. 'glm-5.1' (200K ctx, agentic flagship) for hardest tasks; 'glm-4.7' is the workhorse default for code/explore (replaces retired glm-4.6); 'glm-4.5-air' (~0.7s) or 'glm-4.5-flash' (~0.8s) for fast/cheap; 'glm-4.7-flash' is reachable but currently slow (~30s) on this plan, prefer the 4.5 variants. AVOID 'glm-4.6' with thinking:true — runaway reasoning verified in matrix harness.",
  deepseek:
    "Override default model. 'deepseek-v4-pro' is the reasoning-capable flagship (works with thinking + tool calls); 'deepseek-v4-flash' is faster/cheaper for non-reasoning workloads.",
  kimi: "Override default model. 'kimi-k2.6' (262K ctx, multimodal, agentic flagship — thinking on by default) is the default; 'kimi-k2.5' is the slightly older alternative; 'kimi-k2-thinking' / '-turbo' force thinking always-on; 'moonshot-v1-{8k,32k,128k}' for legacy non-reasoning variants.",
};

const VISION_MODEL_HINTS: Record<VisionProvider, string> = {
  zai: "Override default vision model. 'glm-4.6v' is the balanced default; 'glm-4.5v' is the prior-gen alternative.",
  kimi: "Override default vision model. 'kimi-k2.6' is the multimodal default; 'kimi-k2.5' as an alternative; moonshot-v1-*-vision-preview series are OCR-only legacy variants.",
};

function textModelField(provider: Provider) {
  return {
    model: z
      .enum(TEXT_MODELS_BY_PROVIDER[provider])
      .optional()
      .describe(TEXT_MODEL_HINTS[provider]),
  };
}

function visionModelField(provider: VisionProvider) {
  return {
    model: z
      .enum(VISION_MODELS_BY_PROVIDER[provider])
      .optional()
      .describe(VISION_MODEL_HINTS[provider]),
  };
}

// === Shared base shape ===
//
// Provider-neutral fields that every tool inherits.

const baseShape = {
  task: z.string().min(1).max(8000).describe("The actual ask. Be specific."),
  context: z
    .array(z.string().max(20000))
    .max(20)
    .optional()
    .describe(
      "File excerpts, prior outputs, or any reference material the model should read before answering.",
    ),
  file_paths: z
    .array(z.string().min(1).max(4000))
    .max(20)
    .optional()
    .describe(
      "Absolute paths to files the server should read and prepend to context[]. " +
        "Each file is capped at 200KB; larger files are truncated with a marker. " +
        "Use this instead of pre-packing context[] when the source is on-disk — " +
        "saves the parent from issuing N Read calls before invoking this tool. " +
        "Allowed roots gated by MCP_FILE_PATHS_ALLOWED_ROOTS env (default ~/, /tmp).",
    ),
  format: z.enum(["text", "json", "markdown"]).default("text").describe("Desired output format."),
  max_output_tokens: z
    .number()
    .int()
    .min(64)
    .max(131072)
    .default(8000)
    .describe(
      "Hard cap on response length. Defaults to 8000. Pass 32768+ for long " +
        "reviews/research that risk truncation. Note: actual emission is " +
        "bounded by the model's effective output budget (remaining context " +
        "after input + thinking tokens).",
    ),
  temperature: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Sampling temperature 0-1. Provider applies its own default when omitted: " +
        "Z.ai/Kimi force 1.0 when thinking, 0.3 otherwise. DeepSeek omits the " +
        "field entirely under thinking (it's a no-op there) and uses 0.3 when off.",
    ),
  thinking: z
    .boolean()
    .describe(
      "REQUIRED. Toggle the provider's reasoning mode. " +
        "Set TRUE for tasks that benefit from chain-of-thought: refactor/debug/algorithm design, code review, research/analysis/synthesis, exhaustive lookups, comparison or critique, root-cause analysis, UX/accessibility/visual-hierarchy review, any non-trivial decision. " +
        "Set FALSE for mechanical work: rename/format/typo fixes, simple completions, describing/identifying images, OCR, transcription, single-line edits, trivial lookups. " +
        "Pick deliberately — there is no server-side default; you must specify on every call.",
    ),
};

// === Per-tool shape factories ===
//
// Each returns a zod-shape object (not a z.object) so callers can destructure
// extra fields when registering. Keyed by (provider, toolKind).

export function makeCodeShape(provider: Provider) {
  return {
    ...baseShape,
    ...textModelField(provider),
    language: z
      .string()
      .max(40)
      .optional()
      .describe(
        "Language hint (e.g. 'typescript', 'python'). Helps the model produce idiomatic code.",
      ),
  } as const;
}

export function makeReviewShape(provider: Provider) {
  return {
    ...baseShape,
    ...textModelField(provider),
    focus: z
      .array(z.enum(["security", "performance", "correctness", "style"]))
      .max(4)
      .optional()
      .describe("Categories to prioritize. Omit for a general review."),
  } as const;
}

export function makeResearchShape(provider: Provider) {
  return {
    ...baseShape,
    ...textModelField(provider),
    cite_format: z
      .enum(["inline", "footnote"])
      .default("inline")
      .describe(
        "Citation style. 'inline' = '[source:N]' inline, 'footnote' = trailing references list.",
      ),
  } as const;
}

export function makeDelegateShape(provider: Provider) {
  return {
    ...baseShape,
    ...textModelField(provider),
  } as const;
}

export function makeVisionShape(provider: VisionProvider) {
  return {
    ...baseShape,
    ...visionModelField(provider),
    images: z
      .array(z.string().min(1).max(2_000_000))
      .min(1)
      .max(10)
      .describe(
        "Image inputs. Each item is either an https URL or a data:image/...;base64,... data URL. 1-10 images.",
      ),
  } as const;
}

// kimi__plan — Kimi-only planning tool. Same shape as delegate (no extra knobs)
// — the planning behavior comes from the system prompt, not schema fields.
export function makePlanShape() {
  return {
    ...baseShape,
    ...textModelField("kimi"),
  } as const;
}

// === Explore shape ===
//
// Structurally different: server-side ReAct loop with up to 10 tools. Inherits
// the base shape minus images and the json/text format split.

const exploreBase = {
  task: baseShape.task,
  context: baseShape.context,
  file_paths: baseShape.file_paths,
  format: z
    .enum(["text", "markdown", "json"])
    .default("markdown")
    .describe(
      "Output format. `text`/`markdown` return the model's synthesis followed " +
        "by a one-line meta footer (model, tokens, latency split, subtype, etc.). " +
        "`json` returns a parseable object `{ content, stats }` where `stats` " +
        "exposes every footer field as a structured value (subtype, stop_reason, " +
        "cost_usd, tool_breakdown, hooks, etc.) — use when you need to pattern-" +
        "match on subtype programmatically instead of regexing the footer.",
    ),
  max_output_tokens: baseShape.max_output_tokens,
  temperature: baseShape.temperature,
  thinking: baseShape.thinking,
};

export function makeExploreShape(provider: Provider) {
  return {
    ...exploreBase,
    ...textModelField(provider),
    roots: z
      .array(z.string().min(1).max(4000))
      .min(1)
      .max(10)
      .describe(
        "Absolute paths to directories the explorer is allowed to search under. " +
          "Must be inside MCP_FILE_PATHS_ALLOWED_ROOTS (default $HOME and /tmp). " +
          "These are passed to the model as the only valid `root`/`path` arguments " +
          "for its filesystem tools.",
      ),
    max_iterations: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe(
        "Hard ceiling on ReAct turns; primary halt is convergence detection, " +
          "not this counter. Each turn = one model call + the tool executions " +
          "it requests. Default 50 — well-behaved loops finish on no-progress " +
          "(3 consecutive iterations with no novel tool calls and <256 bytes " +
          "of new output) long before reaching this. Raise toward the 200 hard " +
          "ceiling only for exhaustive audits, and lift wall_time_ms and " +
          "max_total_tool_bytes alongside it. Older tool results are auto- " +
          "compacted in place so input tokens stay bounded. When this ceiling " +
          "(or any other cap) is reached, the final iteration is reserved for " +
          "synthesis: the model is forced to stop calling tools and produce a " +
          "partial-but-real answer from what it gathered.",
      ),
    allowed_tools: z
      .array(z.enum(EXPLORE_TOOL_NAMES))
      .max(EXPLORE_TOOL_NAMES.length)
      .optional()
      .describe(
        "Whitelist of tool names exposed to the model. Mirrors native Claude " +
          "Code's `allowed_tools`. When set, only these tools are visible in the " +
          "model's tool definitions (so it cannot even attempt to call others). " +
          "When omitted, all 10 tools are available (6 read-only: list_dir, " +
          "read_file, glob, grep, web_fetch, web_search; 4 mutating: write_file, " +
          "write_files, notebook_edit, bash). Use to force a specific shape — e.g. " +
          "`['read_file']` to forbid searching when the caller already knows " +
          "which files to read, or `['list_dir','read_file','glob','grep']` to " +
          "force read-only-fs exploration without web or write capability.",
      ),
    disallowed_tools: z
      .array(z.enum(EXPLORE_TOOL_NAMES))
      .max(EXPLORE_TOOL_NAMES.length)
      .optional()
      .describe(
        "Blacklist of fs tool names. Mirrors native Claude Code's " +
          "`disallowed_tools`. Removed from the exposed set AFTER allowed_tools " +
          "is applied (so disallow always wins). Use to block expensive ops on " +
          "huge trees — e.g. `['grep']` if you don't want regex sweeps.",
      ),
    wall_time_ms: z
      .number()
      .int()
      .min(1000)
      .max(1_800_000)
      .optional()
      .describe(
        "Per-call wall-clock cap for the loop in ms. Overrides the " +
          "`MCP_EXPLORE_WALL_MS` env (default 600_000 = 10 min). Enforced via " +
          "AbortController so a slow chat response gets preempted instead of " +
          "running over. Min 1s, max 30 min.",
      ),
    max_total_tool_bytes: z
      .number()
      .int()
      .min(1024)
      .max(10_485_760)
      .optional()
      .describe(
        "Per-call cap on cumulative fs-tool output bytes. Overrides the " +
          "`MCP_EXPLORE_MAX_TOOL_BYTES` env (default 4_000_000 = 4 MB). When " +
          "exceeded, the loop appends a synthesis prompt and produces a final " +
          "answer from what's been gathered. Min 1 KB, max 10 MB.",
      ),
    max_budget_usd: z
      .number()
      .positive()
      .max(10)
      .optional()
      .describe(
        "Per-call PaaS-tier spend cap in USD. Computed from cumulative tokens " +
          "via the per-(provider,model) rates in pricing.ts. When exceeded, the " +
          "loop pushes a system note telling the model to stop calling tools and " +
          "synthesize, and reports `subtype:error_max_budget_usd`. NOTE: Coding " +
          "Plan / membership-plan callers don't actually pay per-token — this is " +
          "an efficiency cap, not a billing cap. Max $10.",
      ),
  } as const;
}

// === Swarm shape ===
//
// Wraps the explore shape: same fs/web tool catalog and roots requirement, but
// the runner expects a coordinator → fan-out → aggregator pipeline. The
// coordinator decomposes the task into N sub-agents (each is a runExploreLoop)
// and the aggregator synthesizes their outputs. `num_agents` and
// `max_iterations_per_agent` are the swarm-specific knobs.

export function makeSwarmShape(provider: Provider) {
  // Drop max_iterations from the explore base (swarm has per-agent caps
  // instead of one global iteration cap) by destructuring it out.
  const explore = makeExploreShape(provider);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { max_iterations: _drop, ...exploreNoMaxIter } = explore;
  return {
    ...exploreNoMaxIter,
    num_agents: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe(
        "Hard cap on parallel sub-agents. When omitted, the coordinator decides " +
          "in [3, 8] based on task structure. Set to 1 to force degeneracy (no " +
          "parallelism — useful for sanity checks). Set higher to widen parallelism " +
          "for genuinely fan-out-shaped tasks (e.g. one sub-agent per source " +
          "document in a 10-document research synthesis).",
      ),
    max_iterations_per_agent: z
      .number()
      .int()
      .min(12)
      .max(50)
      .default(30)
      .describe(
        "Per-sub-agent iteration cap (vs explore's 50 default). Min 12 — " +
          "verified across swarm-r1/r2/r3: at 6-8 iters every codebase_explore " +
          "sub-agent hit iter_cap; at 10 still 1-2 of 3 hit cap on real " +
          "fs-exploration tasks. 12 is the minimum that supports list_dir → " +
          "glob → grep → read with room to converge. Default 30 (lifted from " +
          "18 in r7 — sub-agents at 18 iters were still hitting cap on real " +
          "codebase exploration; 30 gives headroom for thorough enumeration). " +
          "Raise toward 50 for exhaustive audits. The coordinator's per-sub-" +
          "task `max_iterations` hint is no longer used as a ceiling — the " +
          "swarm-level cap dominates and the no-progress detector handles " +
          "early exit on quick tasks.",
      ),
  } as const;
}

export function makeSwarmV2Shape(provider: Provider) {
  // Drop max_iterations (v2 uses max_orchestration_rounds for the CEO and
  // max_iterations_per_subagent for sub-agents) AND num_agents (the CEO
  // decides per-spawn dynamically; not a fixed cap).
  const explore = makeExploreShape(provider);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { max_iterations: _drop, ...exploreNoMaxIter } = explore;

  // Per-provider iter cap default. Plan §"Per-provider max_iterations_per_subagent":
  // resolved at schema-factory time. K2.6 reasoning runaway is monotonic with
  // iter count (verified r12-r15), so kimi caps at 18; glm/deepseek at 30.
  const iterDefault = provider === "kimi" ? 18 : 30;

  return {
    ...exploreNoMaxIter,
    max_total_subagents: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(100)
      .describe(
        "Hard ceiling on total agents in the tree (CEO + all sub-agents at all depths). " +
          "Default 100 (Kimi Agent Swarm parity baseline). Range allows up to 200 — raise " +
          "for tool-call-dense workloads (verified 2026-05-10 parity push: 200 agents × " +
          "~10 calls/agent clears the 1,500 tool-calls bar). Lower to bound spend.",
      ),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(3)
      .describe(
        "Recursion depth cap. 1 = CEO + leaves only (no recursion); 2 = CEO + " +
          "depth-1 + depth-2 leaves; 3 = full tree. Default 3.",
      ),
    max_orchestration_rounds: z
      .number()
      .int()
      .min(3)
      .max(50)
      .default(30)
      .describe(
        "CEO's explore-loop iteration cap. Each iteration the CEO may call " +
          "spawn_subagents (or fs tools, or emit final synthesis). Default 30 " +
          "matches v1's per-agent cap. Range [3, 50].",
      ),
    max_iterations_per_subagent: z
      .number()
      .int()
      .min(12)
      .max(50)
      .default(iterDefault)
      .describe(
        `Per-sub-agent iter cap. Default ${iterDefault} for ${provider} (kimi=18 because ` +
          "K2.6 reasoning runaway is monotonic with iter count, verified r12-r15; " +
          "glm/deepseek=30 per v1's r7 sweet spot). Min 12.",
      ),
    subagent_concurrency: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe(
        "Override per-provider semaphore slot count (default 8 for zai, 4 for deepseek/kimi). " +
          "Caps concurrent in-flight LLM-calling sub-agents. Useful for rate-limit-sensitive " +
          "providers or to bound parallelism on small trees.",
      ),
  } as const;
}

// Academic deep-research tool. Single-question input — the pipeline
// internally handles plan/search/relevance/fulltext/synthesize/verify across
// 11 sources. `model` overrides the synthesize stage (the most user-facing
// call); plan/relevance/verify use stage-specific defaults from
// ACADEMIC_STAGE_MODELS unless overridden via env vars. `thinking` is
// auto-applied per stage so callers don't pick.
export function makeAcademicShape(provider: Provider) {
  return {
    question: z
      .string()
      .min(8)
      .max(2000)
      .describe(
        "The research question. Phrase as the actual question the literature should answer " +
          "(e.g., 'What is the current evidence linking gut microbiome composition to depression in humans?'). " +
          "Avoid keyword-only inputs — the pipeline decomposes this into search queries internally.",
      ),
    model: z
      .enum(TEXT_MODELS_BY_PROVIDER[provider])
      .optional()
      .describe(
        "Override the synthesize-stage model (the most user-facing call). " +
          "Plan / relevance / verify stages use their own defaults regardless of this. " +
          TEXT_MODEL_HINTS[provider],
      ),
  } as const;
}

// Per-(provider, toolKind) input types are inferred ad-hoc by callers via
// z.infer<z.ZodObject<ReturnType<typeof makeXxxShape>>> when needed. We don't
// pre-declare them here because the produced shapes are runtime-narrowed by
// provider; index.ts handles arg typing inline.
