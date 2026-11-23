//
// ARCH-3 Phase 1: Extract-Prompt Variant Optimization via LongMemEval
// (learned context-update tool, offline prompt-search lane)
//
// NOTE: no shebang — this file is imported by its vitest suite, and Vite's
// import analysis rejects shebang lines. Invoke as:
//   node --import tsx extensions/memory-l3/scripts/optimize-extract-prompt.ts
// Structural sibling of optimize-weights.ts (coordinate descent over scoring
// weights) with the search space swapped to DISCRETE prompt variants: a
// curated, version-tagged table (extract-prompt-variants.json) over the two
// extraction prompts — EXTRACT_SYSTEM_PROMPT (llm.ts "extract" lane) and
// EXTRACT_SYSTEM_PROMPT_NATIVE ("native" lane). Variants are injected through
// the env-file override seam in llm.ts (resolveExtractSystemPrompt), so every
// evaluation runs the PRODUCTION extractFacts/extractFactsNative lanes.
//
// ## Algorithm
//
// 1. Load + validate the variant table (baseline first, unique ids, target
//    enum, non-empty text — loadVariantTable throws VariantTableError).
// 2. Evaluate variants EXHAUSTIVELY within --budget (no ±step over strings);
//    the baseline is always evaluated FIRST (cache warm + reference number).
// 3. Rank by LongMemEval accuracy (judge: score-longmemeval.mjs), per-type
//    aggregate as tiebreak.
// 4. Guards on the top-2 when --guards: repeated-compaction-test.mjs and
//    temporal-survival-audit.mjs under the variant env vs baseline env; a
//    guard failure disqualifies the variant.
// 5. Write a recommendation JSON. NEVER self-applies: adopting a winner as
//    PROMPT_VERSION=21 (constant + history comment in llm.ts) is a separate
//    operator action, never automated (optimize-weights doctrine).
//
// ## Usage
//
// ```sh
// node --import tsx extensions/memory-l3/scripts/optimize-extract-prompt.ts \
//   --cache=/tmp/lme-cache --stratified=5 --concurrency=2 \
//   --output=/tmp/lme-optimal-prompt.json --dryRun
// ```
//
// Requires (live runs only): an ingested LongMemEval oracle (--cache strongly
// recommended), an Ollama embedder, and a ZAI key. --dryRun validates and
// lists the table with zero LLM spend and writes no output JSON.
//
// ## Safety
//
// Env-only override seam (ZENBRAIN_EXTRACT_PROMPT_OVERRIDE +
// ZENBRAIN_EXTRACT_PROMPT_TARGET) honors the env-only ablation/config
// doctrine — no openclaw.json keys. The seam composes with (never clobbers)
// ZENBRAIN_SCORING_JSON when both are set.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const ENGINE_SCRIPT = path.join(SCRIPT_DIR, "run-longmemeval-engine.ts");
const JUDGE_SCRIPT = path.join(SCRIPT_DIR, "score-longmemeval.mjs");
const GUARD_COMPACTION_SCRIPT = path.join(SCRIPT_DIR, "repeated-compaction-test.mjs");
const GUARD_TEMPORAL_SCRIPT = path.join(SCRIPT_DIR, "temporal-survival-audit.mjs");
const DEFAULT_VARIANTS_PATH = path.join(SCRIPT_DIR, "extract-prompt-variants.json");

// ── Variant table (pure, exported for tests) ────────────────────────────────

export type PromptVariant = {
  id: string;
  target: "extract" | "native";
  systemPrompt: string;
  note?: string;
};

export class VariantTableError extends Error {}

/**
 * Load + validate the curated variant table. Validation laws (plan §1):
 * JSON object with a `variants` array; every entry has a non-empty unique id,
 * target ∈ {extract, native}, and non-empty systemPrompt; the FIRST entry
 * must be the `v20-baseline` extract-lane baseline. Hard-fails otherwise —
 * a malformed table must never silently run a subset.
 */
export function loadVariantTable(jsonText: string): PromptVariant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new VariantTableError(
      `variant table is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VariantTableError("variant table must be a JSON object");
  }
  const variants = (parsed as { variants?: unknown }).variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new VariantTableError('variant table must have a non-empty "variants" array');
  }
  const seen = new Set<string>();
  const out: PromptVariant[] = [];
  for (const raw of variants) {
    if (!raw || typeof raw !== "object") {
      throw new VariantTableError("variant entry must be an object");
    }
    const entry = raw as { id?: unknown; target?: unknown; systemPrompt?: unknown; note?: unknown };
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
      throw new VariantTableError("variant entry needs a non-empty string id");
    }
    if (entry.target !== "extract" && entry.target !== "native") {
      throw new VariantTableError(`variant "${entry.id}" target must be "extract" or "native"`);
    }
    if (typeof entry.systemPrompt !== "string" || entry.systemPrompt.trim().length === 0) {
      throw new VariantTableError(`variant "${entry.id}" needs a non-empty systemPrompt`);
    }
    if (seen.has(entry.id)) {
      throw new VariantTableError(`duplicate variant id: "${entry.id}"`);
    }
    seen.add(entry.id);
    out.push({
      id: entry.id,
      target: entry.target,
      systemPrompt: entry.systemPrompt,
      ...(typeof entry.note === "string" && entry.note.length > 0 ? { note: entry.note } : {}),
    });
  }
  if (out[0]?.id !== "v20-baseline" || out[0].target !== "extract") {
    throw new VariantTableError(
      'the first variant must be the "v20-baseline" extract-lane baseline',
    );
  }
  return out;
}

/** Budget selection (H4): exhaustive within budget, baseline always first. */
export function selectVariantsWithinBudget(
  variants: PromptVariant[],
  budget: number,
): PromptVariant[] {
  if (!Number.isFinite(budget) || budget < 1) {
    throw new VariantTableError(`budget must be >= 1, got: ${budget}`);
  }
  return variants.slice(0, Math.max(1, Math.floor(budget)));
}

// ── Judge stdout parsing (pure, exported for tests — D4 fixture contract) ──

export type JudgeScores = {
  accuracy: number;
  perType: Record<string, { total: number; hits: number }>;
};

/**
 * Parse score-longmemeval.mjs summary stdout. Real shape (pinned by fixture
 * test; contract drift here = silent wrong ranking):
 *   `  single                        5/10 (50%)`
 *   `  OVERALL                        12/50 (24%)`
 * Non-hits/total shaped lines ("N of M" temporal/supersession wording) must
 * NOT pollute perType.
 */
export function parseJudgeStdout(stdout: string): JudgeScores | null {
  const overallMatch = stdout.match(/OVERALL\s+\d+\/(\d+)\s+\((\d+)%\)/);
  if (!overallMatch) {
    return null;
  }
  const total = Number.parseInt(overallMatch[1]!, 10);
  const pct = Number.parseInt(overallMatch[2]!, 10);
  const perType: Record<string, { total: number; hits: number }> = {};
  const typeRegex = /(\S+)\s+(\d+)\/(\d+)\s+\((\d+)%\)/g;
  let m: RegExpExecArray | null;
  while ((m = typeRegex.exec(stdout)) !== null) {
    const tName = m[1];
    if (tName && tName !== "OVERALL") {
      perType[tName] = {
        hits: Number.parseInt(m[2]!, 10),
        total: Number.parseInt(m[3]!, 10),
      };
    }
  }
  return { accuracy: pct / 100, perType };
}

// ── Ranking + recommendation (pure, exported for tests) ────────────────────

export type VariantEvalResult = {
  variantId: string;
  accuracy: number;
  perType: Record<string, { total: number; hits: number }>;
  hypothesisPath: string;
  metaPath: string;
};

/** Per-type mean accuracy — the deterministic tiebreak signal. */
function perTypeMean(perType: Record<string, { total: number; hits: number }>): number {
  const values = Object.values(perType).map((b) => (b.total > 0 ? b.hits / b.total : 0));
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Rank by accuracy desc, per-type aggregate desc, then variantId asc for
 * full determinism. Non-mutating (sorts a copy).
 */
export function rankResults(results: VariantEvalResult[]): VariantEvalResult[] {
  return [...results].sort((left, right) => {
    if (right.accuracy !== left.accuracy) {
      return right.accuracy - left.accuracy;
    }
    const tie = perTypeMean(right.perType) - perTypeMean(left.perType);
    if (tie !== 0) {
      return tie;
    }
    return left.variantId.localeCompare(right.variantId);
  });
}

export type GuardResult = {
  variantId: string;
  guard: string;
  passed: boolean;
  detail: string;
};

export type Recommendation = {
  recommendedVariantId: string | null;
  baselineAccuracy: number;
  results: VariantEvalResult[];
  guards: GuardResult[];
  timestamp: string;
  tip: string;
};

/**
 * Build the recommendation JSON. A guard-disqualified variant can never be
 * recommended; if every variant is disqualified, recommendedVariantId is
 * null. Recommending the baseline means "keep v20".
 */
export function buildRecommendation(params: {
  ranked: VariantEvalResult[];
  baselineAccuracy: number;
  guards: GuardResult[];
}): Recommendation {
  const disqualified = new Set(params.guards.filter((g) => !g.passed).map((g) => g.variantId));
  const winner = params.ranked.find((r) => !disqualified.has(r.variantId));
  return {
    recommendedVariantId: winner ? winner.variantId : null,
    baselineAccuracy: params.baselineAccuracy,
    results: params.ranked,
    guards: params.guards,
    timestamp: new Date().toISOString(),
    tip: winner
      ? `Review per-guard deltas and variance before adopting "${winner.variantId}" as PROMPT_VERSION=21 — this JSON never self-applies.`
      : "Every ranked variant failed a guard — keep v20 and re-curate the table.",
  };
}

// ── Evaluation (spawns; injectable for tests — H6) ──────────────────────────

type SpawnLike = typeof spawnSync;

export type VariantEvaluationParams = {
  variant: PromptVariant;
  cacheDir: string;
  stratified: number;
  concurrency: number;
  oraclePath: string;
  spawnImpl?: SpawnLike;
  /** Injectable override-file writer (tests); default writes a tmp file. */
  writeOverrideFile?: (text: string, variantId: string) => string;
};

function defaultWriteOverrideFile(text: string, variantId: string): string {
  const file = path.join(
    tmpdir(),
    `lme-prompt-variant-${variantId.replace(/[^a-z0-9-]/giu, "_")}.txt`,
  );
  writeFileSync(file, text, "utf8");
  return file;
}

/**
 * Evaluate one variant: spawn the production LongMemEval engine with the
 * env-file override seam armed for this variant, then judge with
 * score-longmemeval.mjs. Mirrors optimize-weights.ts runEvaluation exactly
 * (spawn args, 10-min timeout, stdout-regex path extraction, judge call)
 * except the engine env carries ZENBRAIN_EXTRACT_PROMPT_OVERRIDE +
 * ZENBRAIN_EXTRACT_PROMPT_TARGET — composing with, never clobbering, an
 * ambient ZENBRAIN_SCORING_JSON.
 */
export function runVariantEvaluation(params: VariantEvaluationParams): VariantEvalResult {
  const spawnImpl = params.spawnImpl ?? spawnSync;
  const writeOverrideFile = params.writeOverrideFile ?? defaultWriteOverrideFile;
  const overridePath = writeOverrideFile(params.variant.systemPrompt, params.variant.id);

  console.log(`  [variant ${params.variant.id}] target=${params.variant.target}`);
  const engineEnv = {
    ...process.env,
    ZENBRAIN_EXTRACT_PROMPT_OVERRIDE: overridePath,
    ZENBRAIN_EXTRACT_PROMPT_TARGET: params.variant.target,
  };
  const engineResult = spawnImpl(
    "node",
    [
      "--import",
      "tsx",
      ENGINE_SCRIPT,
      `--cache=${params.cacheDir}`,
      `--stratified=${params.stratified}`,
      `--concurrency=${params.concurrency}`,
      `--oracle=${params.oraclePath}`,
    ],
    { env: engineEnv, cwd: REPO_ROOT, encoding: "utf8", timeout: 600_000 },
  );

  if (engineResult.status !== 0) {
    console.error(`    Engine failed: ${(engineResult.stderr ?? "").slice(0, 500)}`);
    return {
      variantId: params.variant.id,
      accuracy: 0,
      perType: {},
      hypothesisPath: "",
      metaPath: "",
    };
  }

  const engineOutput = engineResult.stdout ?? "";
  const hypoMatch = engineOutput.match(/Wrote (.+hypothesis-engine-.+\.jsonl)/);
  const metaMatch = engineOutput.match(/(memory\/.+runmeta-engine-.+\.json)/);
  if (!hypoMatch) {
    console.error("    Could not find hypothesis file in engine output");
    return {
      variantId: params.variant.id,
      accuracy: 0,
      perType: {},
      hypothesisPath: "",
      metaPath: "",
    };
  }
  const hypothesisPath = hypoMatch[1]!;

  const judgeResult = spawnImpl(
    "node",
    [JUDGE_SCRIPT, hypothesisPath, `--concurrency=${params.concurrency}`],
    { env: process.env, cwd: REPO_ROOT, encoding: "utf8", timeout: 600_000 },
  );
  if (judgeResult.status !== 0) {
    console.error(`    Judge failed: ${(judgeResult.stderr ?? "").slice(0, 500)}`);
    return {
      variantId: params.variant.id,
      accuracy: 0,
      perType: {},
      hypothesisPath,
      metaPath: metaMatch?.[1] ?? "",
    };
  }

  const scores = parseJudgeStdout(judgeResult.stdout ?? "");
  if (!scores) {
    console.error("    Could not parse judge output");
    return {
      variantId: params.variant.id,
      accuracy: 0,
      perType: {},
      hypothesisPath,
      metaPath: metaMatch?.[1] ?? "",
    };
  }
  console.log(`    Accuracy: ${(scores.accuracy * 100).toFixed(1)}%`);
  return {
    variantId: params.variant.id,
    accuracy: scores.accuracy,
    perType: scores.perType,
    hypothesisPath,
    metaPath: metaMatch?.[1] ?? "",
  };
}

/** Run one guard CLI under the variant env (L1/L2 lanes, operator-gated). */
function runGuard(
  guardScript: string,
  guardArgs: string[],
  variant: PromptVariant,
  overridePath: string,
): GuardResult {
  const guardEnv = {
    ...process.env,
    ZENBRAIN_EXTRACT_PROMPT_OVERRIDE: overridePath,
    ZENBRAIN_EXTRACT_PROMPT_TARGET: variant.target,
  };
  const result = spawnSync("node", [guardScript, ...guardArgs], {
    env: guardEnv,
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 600_000,
  });
  const passed = result.status === 0;
  return {
    variantId: variant.id,
    guard: path.basename(guardScript),
    passed,
    detail: passed
      ? "exit 0 under variant env"
      : `exit ${result.status}: ${(result.stderr ?? "").slice(0, 300)}`,
  };
}

// ── CLI (inert under test import) ───────────────────────────────────────────

const args = process.argv.slice(2);
const argVal = (name: string): string | null => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};

async function main(): Promise<void> {
  const variantsPath = argVal("variants") ?? DEFAULT_VARIANTS_PATH;
  const cacheDir = argVal("cache") ?? "/tmp/lme-cache";
  const stratified = Number.parseInt(argVal("stratified") ?? "5", 10);
  const concurrency = Number.parseInt(argVal("concurrency") ?? "2", 10);
  const outputPath = argVal("output") ?? "/tmp/lme-optimal-prompt.json";
  const oraclePath = argVal("oracle") ?? "/tmp/longmemeval/oracle.json";
  const budget = Number.parseInt(argVal("budget") ?? "8", 10);
  const runGuards = argVal("guards") !== "0";
  const dryRun = args.includes("--dryRun");

  console.log("=== Extract-Prompt Variant Optimization via LongMemEval (ARCH-3 Phase 1) ===");
  console.log(`Strategy: exhaustive discrete variant search (no coordinate descent over strings)`);
  console.log(`Variant table: ${variantsPath}`);
  console.log(`Budget: ${budget} · Stratified: ${stratified}/type · Concurrency: ${concurrency}`);
  console.log(`Cache: ${cacheDir}`);
  console.log(
    `Guards: ${runGuards ? "top-2 (repeated-compaction + temporal-survival)" : "disabled"}`,
  );
  console.log(`Output: ${outputPath}`);

  let variants: PromptVariant[];
  try {
    variants = loadVariantTable(readFileSync(variantsPath, "utf8"));
  } catch (error) {
    console.error(`Variant table invalid: ${error instanceof Error ? error.message : "unknown"}`);
    process.exitCode = 1;
    return;
  }
  const selected = selectVariantsWithinBudget(variants, budget);

  if (dryRun) {
    console.log(
      `\n--dryRun: table valid (${variants.length} variants, ${selected.length} within budget). Zero LLM spend; no output JSON written.`,
    );
    for (const v of selected) {
      console.log(
        `  - ${v.id} [${v.target}] ${v.systemPrompt.length} chars${v.note ? ` — ${v.note}` : ""}`,
      );
    }
    return;
  }

  const results: VariantEvalResult[] = [];
  for (const variant of selected) {
    results.push(runVariantEvaluation({ variant, cacheDir, stratified, concurrency, oraclePath }));
  }
  const baselineAccuracy = results[0]?.accuracy ?? 0;
  console.log(
    `\nBaseline (${results[0]?.variantId ?? "?"}) accuracy: ${(baselineAccuracy * 100).toFixed(1)}%`,
  );

  const ranked = rankResults(results);
  const guards: GuardResult[] = [];
  if (runGuards) {
    for (const candidate of ranked.slice(0, 2)) {
      if (candidate.variantId === "v20-baseline") {
        continue; // baseline needs no guard — it IS the current default
      }
      const variant = selected.find((v) => v.id === candidate.variantId);
      if (!variant) {
        continue;
      }
      const overridePath = defaultWriteOverrideFile(variant.systemPrompt, variant.id);
      guards.push(
        runGuard(GUARD_COMPACTION_SCRIPT, ["--limit=5"], variant, overridePath),
        runGuard(GUARD_TEMPORAL_SCRIPT, [], variant, overridePath),
      );
    }
  }

  const recommendation = buildRecommendation({ ranked, baselineAccuracy, guards });
  writeFileSync(outputPath, JSON.stringify(recommendation, null, 2), "utf8");
  console.log(
    `\nRecommended: ${recommendation.recommendedVariantId ?? "(none — all guard-disqualified)"}`,
  );
  console.log(`Wrote ${outputPath} (review before adopting; never self-applies).`);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await main();
}
