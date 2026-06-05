// Tool-catalog metadata. Pure data + pure functions, NO side effects. Both
// the MCP server entrypoint (index.ts) and the routing eval (harness/
// routing-eval.ts) import from here. Splitting this out lets the eval pull
// the catalog without spinning up the server.

import type { Provider } from "./providers/types.js";

export type ToolKind =
  | "code"
  | "review"
  | "research"
  | "delegate"
  | "vision"
  | "explore"
  | "plan"
  | "swarm"
  | "swarm_v2"
  | "academic";

export const TOOL_PREFIX: Record<Provider, string> = {
  zai: "glm",
  deepseek: "deepseek",
  kimi: "kimi",
};

export const SUPPORTED_TOOLS: Record<Provider, readonly ToolKind[]> = {
  zai: [
    "code",
    "review",
    "research",
    "delegate",
    "vision",
    "explore",
    "swarm",
    "swarm_v2",
    "academic",
  ],
  deepseek: ["code", "review", "research", "delegate", "explore", "swarm", "swarm_v2", "academic"],
  kimi: [
    "code",
    "review",
    "research",
    "delegate",
    "vision",
    "explore",
    "plan",
    "swarm",
    "swarm_v2",
    "academic",
  ],
};

export function toolNameFor(provider: Provider, kind: ToolKind): string {
  return `${TOOL_PREFIX[provider]}__${kind}`;
}

function readModelEnv(provider: Provider, kind: ToolKind, fallback: string): string {
  // Z.ai keeps its existing GLM_MODEL_* envs (backward compat with prior
  // installs); DeepSeek/Kimi use their own prefix.
  const prefix = provider === "zai" ? "GLM" : TOOL_PREFIX[provider].toUpperCase();
  const perTool = process.env[`${prefix}_MODEL_${kind.toUpperCase()}`];
  if (perTool && perTool.trim() !== "") return perTool;
  // Only `delegate` falls back to the provider-global *_MODEL var. Other
  // tool kinds (vision in particular) have type-specific defaults — a
  // generic text-model GLM_MODEL setting must not override `glm-4.6v`.
  if (kind === "delegate") {
    const global = process.env[`${prefix}_MODEL`];
    if (global && global.trim() !== "") return global;
  }
  return fallback;
}

export const DEFAULT_MODELS: Record<Provider, Record<ToolKind, string>> = {
  zai: {
    code: readModelEnv("zai", "code", "glm-4.7"),
    review: readModelEnv("zai", "review", "glm-5.1"),
    research: readModelEnv("zai", "research", "glm-5.1"),
    delegate: readModelEnv("zai", "delegate", "glm-4.7"),
    vision: readModelEnv("zai", "vision", "glm-4.6v"),
    explore: readModelEnv("zai", "explore", "glm-4.7"),
    plan: "", // n/a — never read
    swarm: readModelEnv("zai", "swarm", "glm-5.1"),
    swarm_v2: readModelEnv("zai", "swarm_v2", "glm-5.1"),
    academic: readModelEnv("zai", "academic", "glm-5.1"),
  },
  deepseek: {
    code: readModelEnv("deepseek", "code", "deepseek-v4-flash"),
    review: readModelEnv("deepseek", "review", "deepseek-v4-pro"),
    research: readModelEnv("deepseek", "research", "deepseek-v4-pro"),
    delegate: readModelEnv("deepseek", "delegate", "deepseek-v4-pro"),
    vision: "", // n/a
    explore: readModelEnv("deepseek", "explore", "deepseek-v4-flash"),
    plan: "", // n/a
    swarm: readModelEnv("deepseek", "swarm", "deepseek-v4-pro"),
    swarm_v2: readModelEnv("deepseek", "swarm_v2", "deepseek-v4-pro"),
    academic: readModelEnv("deepseek", "academic", "deepseek-v4-pro"),
  },
  kimi: {
    code: readModelEnv("kimi", "code", "kimi-k2.6"),
    review: readModelEnv("kimi", "review", "kimi-k2.6"),
    research: readModelEnv("kimi", "research", "kimi-k2.6"),
    delegate: readModelEnv("kimi", "delegate", "kimi-k2.6"),
    vision: readModelEnv("kimi", "vision", "kimi-k2.6"),
    explore: readModelEnv("kimi", "explore", "kimi-k2.6"),
    plan: readModelEnv("kimi", "plan", "kimi-k2.6"),
    swarm: readModelEnv("kimi", "swarm", "kimi-k2.6"),
    swarm_v2: readModelEnv("kimi", "swarm_v2", "kimi-k2.6"),
    academic: readModelEnv("kimi", "academic", "kimi-k2.6"),
  },
};

// Per-stage model defaults for the academic pipeline. The `academic` entry in
// DEFAULT_MODELS is the SYNTHESIZE model (the most user-facing stage); plan
// and relevance default to a cheaper/faster model when one is available, and
// verify defaults to the synthesis model. Override via env:
//   ACADEMIC_PLAN_MODEL_<provider>, ACADEMIC_RELEVANCE_MODEL_<provider>,
//   ACADEMIC_VERIFY_MODEL_<provider>.
function readAcademicStageEnv(
  provider: Provider,
  stage: "plan" | "relevance" | "verify",
  fallback: string,
): string {
  const prefix = provider === "zai" ? "GLM" : TOOL_PREFIX[provider].toUpperCase();
  const v = process.env[`ACADEMIC_${stage.toUpperCase()}_MODEL_${prefix}`];
  return v && v.trim() !== "" ? v : fallback;
}

export const ACADEMIC_STAGE_MODELS: Record<
  Provider,
  { plan: string; relevance: string; verify: string }
> = {
  zai: {
    plan: readAcademicStageEnv("zai", "plan", "glm-4.6"),
    relevance: readAcademicStageEnv("zai", "relevance", "glm-4.6"),
    verify: readAcademicStageEnv("zai", "verify", DEFAULT_MODELS.zai.academic),
  },
  deepseek: {
    plan: readAcademicStageEnv("deepseek", "plan", "deepseek-v4-flash"),
    relevance: readAcademicStageEnv("deepseek", "relevance", "deepseek-v4-flash"),
    verify: readAcademicStageEnv("deepseek", "verify", DEFAULT_MODELS.deepseek.academic),
  },
  kimi: {
    plan: readAcademicStageEnv("kimi", "plan", "kimi-k2.6"),
    relevance: readAcademicStageEnv("kimi", "relevance", "kimi-k2.6"),
    verify: readAcademicStageEnv("kimi", "verify", DEFAULT_MODELS.kimi.academic),
  },
};

const PROVIDER_LABEL: Record<Provider, string> = {
  zai: "GLM (Z.ai)",
  deepseek: "DeepSeek",
  kimi: "Kimi (Moonshot)",
};

// Per-(provider, kind) routing hint. Reads as "BEST FOR: ..." in the tool
// description. Calibrated to harness/runs/matrix-2026-05-04-r2 outcomes
// (9-axis fanout judged by glm-5.1, judge-bias delta -1.0).
//
// Routing philosophy: CAPABILITY-FIRST. The user is on a GLM Coding Plan
// (flat-rate; zero marginal cost at use); Kimi and DeepSeek are pay-per-call
// API but the dollar amounts aren't a concern. So:
//   - GLM is the natural default for capability-tied cases (already paid for)
//   - Switch to deepseek when SPEED matters (v4-flash is genuinely faster)
//   - Switch to kimi when CONTEXT SIZE demands it (262K window) or for plan
//   - Don't pick by cost — cost is roughly equal for this user
export const MATRIX_VERDICT: Record<Provider, Partial<Record<ToolKind, string>>> = {
  zai: {
    code: "PREFERRED DEFAULT for code generation/refactor — GLM is on Coding Plan (zero marginal cost) and ties top-tier on code-gen quality. glm-5.1 for the hardest reasoning; glm-4.7 is the workhorse. Switch to deepseek__code when wall-clock speed matters more than reasoning depth (v4-flash is ~5-10× faster). Avoid forcing thinking:true on glm-4.6 — runaway reasoning.",
    review:
      "PREFERRED DEFAULT for substantive code review. glm-5.1+thinking is top-tier on bug-finding and reasoning-grounded review. Switch to deepseek__review only when speed matters (v4-flash is faster). Avoid glm-4.6+thinking — reasoning runaway.",
    research:
      "PREFERRED DEFAULT for research/synthesis on inputs that fit in 200K context. Citation discipline ties top-tier. Switch to kimi__research only when source material exceeds ~100KB (kimi has 262K window).",
    delegate:
      "PREFERRED DEFAULT for general Q&A, summarization, compression, translations, simple lookups, format=json coercion, single-shot transformations. GLM is on Coding Plan (free at use). Switch to deepseek__delegate only when wall-clock speed is the bottleneck (v4-flash ~1-2s vs glm ~5-10s).",
    vision:
      "ONLY calibrated vision tool in this catalog (default model glm-4.6v). Use freely for description / OCR / UX critique / accessibility / visual reasoning.",
    explore:
      "PREFERRED DEFAULT for codebase exploration in the small-to-medium range (fits in glm-5.1's 200K context). Switch to kimi__explore only when codebase exceeds that.",
    swarm:
      "FALLBACK only — prefer glm__swarm_v2. Same one-shot decompose → fanout → aggregate (no recursion). Verified r4+r5 (2026-05-09): 89.6 mean across 7 scenarios; ceilings on v1-friendly tasks (compare_three, multi_axis_audit) but caps at 75/100 on codebase_explore. v2 hits 99.9 mean on the same 7 AND self-collapses to numAgents=1 on v1-shaped inputs, so the simplicity argument no longer holds. Reach for v1 only if you specifically need the linear pipeline for tracing/debug.",
    swarm_v2:
      "PREFERRED DEFAULT for parallel decomposition, multi-axis audit, repo investigation, wide enumeration. Verified r4+r5+parity-push (2026-05-09/10): 99.9 mean across 7 scenarios — 100 on every scenario including recursion / upper-limit / wide-enumeration stress cases. Capacity: 200-agent hard ceiling (lifted 100→200 in 2026-05-10 push; schema default still 100, pass max_total_subagents up to 200 for tool-call-dense workloads), depth-3 recursion verified, 4.4-5.95x speedup at quality 96, peak ~700 tool calls per run. Self-collapses to numAgents=1 on v1-shaped inputs (no overhead). ~5-25min wall depending on tree depth.",
    academic:
      "PREFERRED DEFAULT for academic deep-research. glm-5.1 synthesizer + glm-4.6 plan/relevance — strong citation discipline. Free under Coding Plan. Verified v0.11: 6/6 questions, 0 hallucinations across 115 citations, 96.5% literal-span verification, 39% fulltext-grounded. ~10min wall per question.",
  },
  deepseek: {
    code: "Use when WALL-CLOCK SPEED is the priority over reasoning depth — v4-flash is ~5-10× faster than glm. Quality ties top-tier on most code tasks. Otherwise glm__code is the preferred default (zero marginal cost on Coding Plan).",
    review:
      "Use when SPEED matters (v4-flash reviews in ~25-50s vs glm's ~60-90s) and the review is bug-spotting-shaped, not nuanced judgment. v4-flash matches glm-5.1 quality on planted-bug enumeration. Otherwise glm__review is the default.",
    research:
      "Use as a faster alternative to glm__research at parity quality. For inputs >100KB use kimi__research instead. For inputs fitting glm's 200K window with no speed pressure, glm__research is the default.",
    delegate:
      "Use when SPEED is critical — v4-flash is the fastest delegate (~1-2s wall-clock). Quality ties at top-tier on simple tasks. Otherwise glm__delegate is the default (zero marginal cost on Coding Plan).",
    explore:
      "Use for fast ReAct loops on small-to-medium codebases when speed matters more than reasoning depth. v4-flash is rarely empty-burns. Switch to kimi__explore for very large repos.",
    swarm:
      "FALLBACK only — prefer deepseek__swarm_v2. v2 is BOTH higher quality (r4+r5 mean 98.6 vs v1's 89.9 across 7 scenarios) AND CHEAPER ($0.80 vs $1.40 on r5 7-scenario totals) because v2's CEO-driven flow skips v1's mandatory round-1 aggregator. Use v1 only for backwards-compat with code that already calls it.",
    swarm_v2:
      "BEST FOR: peak parallel speedup AND cheapest v2 swarm. v4-pro thinking-on agents are individually slow (~230s) so parallelism compounds — verified 14.46x speedup on tool_call_density (highest measured), depth-3 recursion fired, 6.29x at full quality on recursion_stress. r4+r5 mean 98.6 across 7 scenarios (parity with glm ±1). r5 7-scenario cost was $0.80 (vs glm $5.02). Caveat: at concurrency 8 + iter_cap 50, deep trees can hit `ceo_synthesis_empty` — keep MCP_SWARM_V2_WALL_MS ≥ 1.8M (30min) for big workloads. Default to glm__swarm_v2 for general use; switch here when SPEED or COST is the priority.",
    academic:
      "DeepSeek-routed academic deep-research. v4-pro synthesizer + v4-flash plan/relevance. Pay-per-call (vs glm__academic free under Coding Plan), so glm__academic is the default unless you specifically want a different reasoning style or a routing eval. Same 11-source pipeline.",
  },
  kimi: {
    code: "BEST FOR: large-context refactors (>50KB inputs). K2.6's 262K context is unmatched and is the reason to pay the latency tax (~10× slower than glm/deepseek). Use only when context size demands it; for smaller inputs prefer glm__code or deepseek__code.",
    review:
      "AVOID for bug-enumeration tasks ('find every X'). K2.6+thinking exhibits reasoning runaway — burns the entire token budget on reasoning before emitting content (verified: empty_content even at 6000-token budget). Use glm__review or deepseek__review instead.",
    research:
      "BEST FOR: long-document research where source material exceeds ~100KB. Citation discipline ties top-tier. Pay the latency tax (~5× slower than glm/deepseek) only for the context advantage.",
    delegate:
      "Niche: only useful when delegating with very long context (>100KB input). For short tasks, glm__delegate (default, free) or deepseek__delegate (fastest) is the right call.",
    vision:
      "K2.6 supports vision but glm__vision (glm-4.6v) is the calibrated default in this catalog. Use kimi__vision only when long-context image reasoning over a bundle of images is needed.",
    explore:
      "BEST FOR: very large codebases (>200K total source). K2.6's 262K context is the only fit when the repo doesn't fit in glm/deepseek. Slowest in the matrix; pay the wall-clock tax for the context.",
    plan: "ONLY exposed on Kimi. Calibrated for K2.6's agentic thinking. Tied top-tier on reasoning_depth. THE tool for 'decompose into verifiable steps' regardless of context size.",
    swarm:
      "AVOID — use kimi__swarm_v2 instead. v1's mandatory aggregator stage triggers K2.6 reasoning-trace corruption (Moonshot-acknowledged). Verified r4+r5: kimi v1 mean 64.9 across 7 scenarios — codebase_explore averaged 20/100 (one round 0/100), multi_round_drill 35/100, wide_enumeration 50/100. v2 on the same provider+model jumps to 99.4 mean because the CEO-as-synthesizer pattern sidesteps the aggregator. No remaining case for kimi__swarm.",
    swarm_v2:
      "PREFERRED kimi-side path for parallel decomposition. v2's CEO-as-synthesizer architecture sidesteps the K2.6 reasoning-trace corruption that capped kimi__swarm at 64.9 mean — v2 jumps to 99.4 mean across r4+r5 (100/100 on codebase_explore vs v1's 20; 100/100 on wide_enumeration vs v1's 50). Pool size 4 (rate-limit calibrated; >4 trips HTTP 429 on K2.6). Caveat: even at concurrency 4, kimi can 429 on the CEO's first spawn round during stress workloads (observed 2026-05-10). ~25-65min wall. Use in PREFERENCE to kimi__swarm for any swarm-shaped task; default to glm__swarm_v2 unless context size or routing eval requires kimi.",
    academic:
      "Kimi-routed academic deep-research. K2.6 for all 4 stages — single-model pipeline. BEST when sources are unusually long (full preprints, lots of fulltext-fetched papers) and the synthesis benefits from K2.6's 262K context. ~5× slower than glm__academic; pay the latency tax only when context size matters.",
  },
};

// `includeMatrixVerdict=false` returns the description WITHOUT the BEST FOR
// line — used by the routing eval to measure causal lift from the verdict.
export function describe(provider: Provider, kind: ToolKind, includeMatrixVerdict = true): string {
  const flag = `Default model: '${DEFAULT_MODELS[provider][kind]}'.`;
  const verdict = includeMatrixVerdict ? MATRIX_VERDICT[provider][kind] : undefined;
  const routingLine = verdict ? ` ${verdict}` : "";
  switch (kind) {
    case "code":
      return `[${PROVIDER_LABEL[provider]}] Delegate a code-generation or code-modification task. ${flag} Pass reference snippets via \`context\`. REQUIRED \`thinking\`: false for mechanical work (rename/format/typo); true for refactor/debug/algorithm/explain.${routingLine}`;
    case "review":
      return `[${PROVIDER_LABEL[provider]}] Delegate a code-review or diff-review task. ${flag} Pass diff/file via \`context\`. REQUIRED \`thinking\`: usually true for substantive reviews; false only for trivial style passes.${routingLine}`;
    case "research":
      return `[${PROVIDER_LABEL[provider]}] Read-and-synthesize from supplied source material WITH CITATIONS. ${flag} Use this when the user wants citation-grounded answers ("cite each claim"); for plain summarization or compression WITHOUT citations, prefer ${TOOL_PREFIX[provider]}__delegate. Always pass source material via \`context\`. REQUIRED \`thinking\`: usually true for analysis/synthesis/comparison; false only for shallow lookups.${routingLine}`;
    case "delegate":
      return `[${PROVIDER_LABEL[provider]}] Generic delegation when no specialized tool fits — also THE tool for: summarization, compression, single-shot transformations, translations, factual lookups, structured-output coercion (format=json). ${flag} REQUIRED \`thinking\`: true for non-trivial fallback work (analysis, decisions, multi-step); false for simple lookups, translations, summarization, compression, format coercion.${routingLine}`;
    case "vision":
      return `[${PROVIDER_LABEL[provider]}] Analyze image(s). ${flag} Pass images as URLs or base64 data URLs in \`images\`. REQUIRED \`thinking\`: false for description/identification/OCR/captioning; true for UX critique, accessibility review, visual reasoning, comparison.${routingLine}`;
    case "explore":
      return `[${PROVIDER_LABEL[provider]}] Explore a local codebase with a server-side ReAct loop. ${flag} The model iteratively calls up to 10 tools (6 read-only fs/web + 4 mutating: write_file, write_files, notebook_edit, bash) until it has enough to answer. The iteration trace stays on the server; you only see the final synthesis. REQUIRED \`thinking\`: usually true (multi-step search benefits from CoT); false only for trivial 'list this dir' tasks.${routingLine}`;
    case "plan":
      return `[${PROVIDER_LABEL[provider]}] Produce an executable plan for a task. ${flag} Calibrated for Kimi K2.6's 262K context + agentic thinking. Decomposes into the smallest verifiable steps with deps/risks/verification per step. Pass source material via \`context\`. REQUIRED \`thinking\`: true (planning fundamentally benefits from CoT).${routingLine}`;
    case "swarm":
      return `[${PROVIDER_LABEL[provider]}] Run a parallel agent swarm: a coordinator decomposes the task into 3-8 independent sub-tasks, fans them out as concurrent ReAct sub-agents (each with the standard 10 fs/web/bash tools), then aggregates their outputs into one synthesis. ${flag} REACH FOR THIS when the user task fits one of these shapes: 'compare N approaches/algorithms/options', 'audit this for X AND Y AND Z' (multi-axis review), 'survey N documents and synthesize', 'find every X in this repo' (parallel enumeration), 'produce an overview of codebase Y'. The coordinator → fanout → aggregate pattern preserves per-axis detail that serial reasoning compresses, and the iteration trace stays on the server (only the final synthesis returns to you). PREFER OVER \`Task\` subagents when branches are truly independent (no shared scratchpad needed) AND each branch benefits from full ReAct iteration with fs/web tool access. Typical wall: ~10-25min depending on provider. NOT for: single-shot Q&A, sequential reasoning chains, single-bug debugging, tasks under ~30s of work — fanout overhead doesn't pay off. Pass \`roots\` (required for fs access; empty array \`[]\` for inline tasks) and optionally \`context\`. REQUIRED \`thinking\`: usually true (decomposition + synthesis benefit from CoT); false only when sub-tasks are mechanical extraction.${routingLine}`;
    case "swarm_v2":
      return `[${PROVIDER_LABEL[provider]}] Run an ITERATIVE agent swarm with recursion: a CEO orchestrator (itself a ReAct loop with the 4 fs tools + a \`spawn_subagents\` extra-tool) calls spawn_subagents across multiple iterations to fan out up to 100 sub-agents at recursion depth ≤ 3. Round 1 explores breadth; round N drills into what prior rounds surfaced; the CEO emits the user-facing synthesis as its final iteration. ${flag} REACH FOR THIS instead of *__swarm (v1) when: (a) the task scales to >16 truly parallel investigations ('survey 50 documents', 'enumerate every X across the codebase'), (b) findings drive follow-up exploration ('explore the repo, then drill into the 3 files that match a pattern'), or (c) sub-tasks themselves are decomposable. PREFER *__swarm (v1) for fixed 3-8-way decompositions where round-1 outputs are sufficient — v1 is simpler, faster, and already at ceiling on those shapes. Pass \`roots\` (required for fs access; empty array \`[]\` for inline tasks) and optionally \`context\`, \`max_total_subagents\` (default 100), \`max_depth\` (default 3), \`max_orchestration_rounds\` (default 30). REQUIRED \`thinking\`: usually true.${routingLine}`;
    case "academic":
      return `[${PROVIDER_LABEL[provider]}] Academic deep-research with citation grounding. Multi-stage pipeline: plan (decompose question into 3-5 search queries) → search across 11 sources (S2, OpenAlex, arXiv, CORE, Europe PMC, Crossref, OSTI, NTRS, DOAJ, Sci-Hub, Anna's Archive) → relevance filter (top-15 by LLM score) → OA-URL resolution (Unpaywall + OpenAlex DOI fallback) → fulltext fetch (PMC NXML, NTRS .txt, OA PDFs via pdftotext) → synthesize (paragraph-citation contract: every claim carries a paper_id + verbatim supporting span + confidence tag) → verify (independent-context support check). ${flag} REACH FOR THIS when the user task is "what does the literature say about X" / "current evidence on X" / "literature review on X" — academic-style research questions where retrieval breadth across scholarly sources matters and zero-hallucination citation is a hard requirement. Returns markdown literature review + machine-readable RunStats (citations, hallucination count, span-verification rate, fulltext yield, federally-funded count). NOT for: general web Q&A (use \`research\`); on-disk docs (use \`research\` with \`context\`); single-paper summarization. Pass only the research question. \`thinking\` is auto-applied per stage — no manual flag needed for this tool. Typical wall: 5-15 min/question. Plan-cache stored at ~/.claude/agentmcp-academic-cache/ — re-runs of identical questions skip the plan stage and use the same query set for reproducibility.${routingLine}`;
  }
}
