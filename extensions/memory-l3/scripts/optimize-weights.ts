#!/usr/bin/env node --import tsx
//
// V(m) Weight Optimization via LongMemEval (arXiv:2606.12945-inspired)
//
// Coordinate-descent optimizer over the L3 scoring weights. Runs the
// PRODUCTION LongMemEval engine harness (run-longmemeval-engine.ts) with
// different `ZENBRAIN_SCORING_JSON` configurations, judges the results with
// score-longmemeval.mjs, and searches for the weight set that maximises
// overall accuracy.
//
// ## Algorithm
//
// 1. Start from DEFAULT_SCORING_CONFIG (or a provided seed).
// 2. For each weight, try ±stepFraction variations.
// 3. Run LongMemEval for each candidate config.
// 4. Judge results with score-longmemeval.mjs.
// 5. Move to the best neighbour if it improves overall accuracy.
// 6. Repeat until no improvement (convergence) or maxIterations.
// 7. Write optimal weights to a JSON file for review.
//
// ## Usage
//
// ```sh
// node --import tsx extensions/memory-l3/scripts/optimize-weights.ts \
//   --cache=/tmp/lme-cache \
//   --stratified=5 \
//   --concurrency=2 \
//   --maxIter=3 \
//   --step=0.25 \
//   --output=/tmp/lme-optimal-weights.json
// ```
//
// Requires: an ingested LongMemEval oracle (--cache strongly recommended so
// ingestion cost is amortised), an Ollama embedder, and a ZAI key.
//
// ## Safety
//
// Does NOT modify DEFAULT_SCORING_CONFIG automatically. The output JSON is
// a recommendation — review variance and hold-out performance before
// applying.

import { spawnSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const ENGINE_SCRIPT = path.join(SCRIPT_DIR, "run-longmemeval-engine.ts");
const JUDGE_SCRIPT = path.join(SCRIPT_DIR, "score-longmemeval.mjs");

const args = process.argv.slice(2);
const argVal = (name: string): string | null => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};

const CACHE_DIR = argVal("cache") ?? "/tmp/lme-cache";
const STRATIFIED = Number.parseInt(argVal("stratified") ?? "5", 10);
const CONCURRENCY = Number.parseInt(argVal("concurrency") ?? "2", 10);
const MAX_ITERATIONS = Number.parseInt(argVal("maxIter") ?? "3", 10);
const STEP_FRACTION = Number.parseFloat(argVal("step") ?? "0.25");
const OUTPUT_PATH = argVal("output") ?? "/tmp/lme-optimal-weights.json";
const ORACLE_PATH = argVal("oracle") ?? "/tmp/longmemeval/oracle.json";

// Weight keys to optimize (skip structural/config params like useFsrs, recencyHalfLifeDays)
const OPTIMIZABLE_KEYS = [
  "weightLexical",
  "weightBm25",
  "weightImportance",
  "weightRecency",
  "weightL3Boost",
  "weightSemantic",
  "weightInformationGain",
  "weightGoalRelevance",
  "weightReliability",
  "weightSemanticEntropy",
  "weightValidity",
] as const;

type ScoringConfig = Record<(typeof OPTIMIZABLE_KEYS)[number], number>;

// Default starting point — mirrors DEFAULT_SCORING_CONFIG from scoring.ts
const DEFAULT_WEIGHTS: ScoringConfig = {
  weightLexical: 0.25,
  weightBm25: 0.3,
  weightImportance: 0.15,
  weightRecency: 0.05,
  weightL3Boost: 0.1,
  weightSemantic: 0.35,
  weightInformationGain: 0.05,
  weightGoalRelevance: 0.1,
  weightReliability: 0.1,
  weightSemanticEntropy: 0.1,
  weightValidity: 0.05,
};

type EvalResult = {
  accuracy: number;
  perType: Record<string, { total: number; hits: number }>;
  hypothesisPath: string;
  metaPath: string;
};

/**
 * Run the LongMemEval engine with a given scoring config, then judge results.
 * Returns the overall accuracy (fraction correct).
 */
function runEvaluation(config: ScoringConfig, iteration: number, keyName: string): EvalResult {
  const scoringJson = JSON.stringify(config);

  console.log(`\n  [iter ${iteration}] Testing ${keyName}...`);
  console.log(`    scoring: ${scoringJson}`);

  // Run the engine
  const engineEnv = {
    ...process.env,
    ZENBRAIN_SCORING_JSON: scoringJson,
  };
  const engineResult = spawnSync(
    "node",
    [
      "--import",
      "tsx",
      ENGINE_SCRIPT,
      `--cache=${CACHE_DIR}`,
      `--stratified=${STRATIFIED}`,
      `--concurrency=${CONCURRENCY}`,
      `--oracle=${ORACLE_PATH}`,
    ],
    {
      env: engineEnv,
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 600_000, // 10 minutes per run
    },
  );

  if (engineResult.status !== 0) {
    console.error(`    Engine failed: ${engineResult.stderr?.slice(0, 500)}`);
    return { accuracy: 0, perType: {}, hypothesisPath: "", metaPath: "" };
  }

  // Find the hypothesis and metadata paths from the engine output
  const engineOutput = engineResult.stdout;
  const hypoMatch = engineOutput.match(/Wrote (.+hypothesis-engine-.+\.jsonl)/);
  const metaMatch = engineOutput.match(/(memory\/.+runmeta-engine-.+\.json)/);

  if (!hypoMatch) {
    console.error(`    Could not find hypothesis file in engine output`);
    return { accuracy: 0, perType: {}, hypothesisPath: "", metaPath: "" };
  }

  const hypothesisPath = hypoMatch[1]!;

  // Run the judge
  const judgeResult = spawnSync(
    "node",
    [JUDGE_SCRIPT, hypothesisPath, `--concurrency=${CONCURRENCY}`],
    {
      env: process.env,
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 600_000,
    },
  );

  if (judgeResult.status !== 0) {
    console.error(`    Judge failed: ${judgeResult.stderr?.slice(0, 500)}`);
    return { accuracy: 0, perType: {}, hypothesisPath, metaPath: metaMatch?.[1] ?? "" };
  }

  // Parse judge output for overall accuracy
  const judgeOutput = judgeResult.stdout;
  const overallMatch = judgeOutput.match(/OVERALL\s+\d+\/(\d+)\s+\((\d+)%\)/);
  if (!overallMatch) {
    console.error(`    Could not parse judge output`);
    return { accuracy: 0, perType: {}, hypothesisPath, metaPath: metaMatch?.[1] ?? "" };
  }

  const total = Number.parseInt(overallMatch[1]!, 10);
  const pct = Number.parseInt(overallMatch[2]!, 10);
  const hits = Math.round((pct / 100) * total);

  // Parse per-type results
  const perType: Record<string, { total: number; hits: number }> = {};
  const typeRegex = /(\S+)\s+(\d+)\/(\d+)\s+\((\d+)%\)/g;
  let m: RegExpExecArray | null;
  while ((m = typeRegex.exec(judgeOutput)) !== null) {
    const tName = m[1];
    if (tName && tName !== "OVERALL") {
      perType[tName] = {
        hits: Number.parseInt(m[2]!, 10),
        total: Number.parseInt(m[3]!, 10),
      };
    }
  }

  console.log(`    Accuracy: ${hits}/${total} (${pct}%)`);

  return {
    accuracy: pct / 100,
    perType,
    hypothesisPath,
    metaPath: metaMatch?.[1] ?? "",
  };
}

/**
 * Generate candidate configs by perturbing each weight.
 * For each key, produces a config with that weight ±stepFraction.
 */
function generateCandidates(
  current: ScoringConfig,
  stepFraction: number,
): Array<{ config: ScoringConfig; key: string; direction: string }> {
  const candidates: Array<{ config: ScoringConfig; key: string; direction: string }> = [];
  for (const key of OPTIMIZABLE_KEYS) {
    const base = current[key];
    const delta = base * stepFraction;
    // Skip if base is 0 (can't perturb from 0 multiplicatively)
    if (base === 0) {
      // Try a small absolute step instead
      candidates.push({
        config: { ...current, [key]: 0.05 },
        key,
        direction: "+abs",
      });
      continue;
    }
    candidates.push({
      config: { ...current, [key]: Math.max(0, base + delta) },
      key,
      direction: `+${stepFraction}`,
    });
    candidates.push({
      config: { ...current, [key]: Math.max(0, base - delta) },
      key,
      direction: `-${stepFraction}`,
    });
  }
  return candidates;
}

async function main(): Promise<void> {
  console.log("=== V(m) Weight Optimization via LongMemEval ===");
  console.log(`Strategy: coordinate descent`);
  console.log(`Starting weights: ${JSON.stringify(DEFAULT_WEIGHTS, null, 2)}`);
  console.log(`Step fraction: ±${STEP_FRACTION}`);
  console.log(`Max iterations: ${MAX_ITERATIONS}`);
  console.log(`Stratified: ${STRATIFIED}/type, concurrency: ${CONCURRENCY}`);
  console.log(`Cache: ${CACHE_DIR}`);
  console.log(`Output: ${OUTPUT_PATH}`);

  // Phase 0: Evaluate the baseline (current defaults)
  console.log("\n--- Baseline evaluation ---");
  const baselineResult = runEvaluation(DEFAULT_WEIGHTS, 0, "baseline");
  console.log(`Baseline accuracy: ${(baselineResult.accuracy * 100).toFixed(1)}%`);

  let bestConfig: ScoringConfig = { ...DEFAULT_WEIGHTS };
  let bestAccuracy: number = baselineResult.accuracy;
  const history: Array<{
    iteration: number;
    key: string;
    direction: string;
    accuracy: number;
    delta: number;
  }> = [{ iteration: 0, key: "baseline", direction: "", accuracy: bestAccuracy, delta: 0 }];

  // Coordinate descent
  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    console.log(`\n--- Iteration ${iter}/${MAX_ITERATIONS} ---`);
    const candidates = generateCandidates(bestConfig, STEP_FRACTION);
    let improved = false;

    for (const candidate of candidates) {
      const result = runEvaluation(
        candidate.config,
        iter,
        `${candidate.key}${candidate.direction}`,
      );
      const delta = result.accuracy - bestAccuracy;

      history.push({
        iteration: iter,
        key: candidate.key,
        direction: candidate.direction,
        accuracy: result.accuracy,
        delta,
      });

      if (delta > 0) {
        console.log(`    ↑ IMPROVED by +${(delta * 100).toFixed(1)}pp`);
        bestConfig = { ...candidate.config };
        bestAccuracy = result.accuracy;
        improved = true;
        // In coordinate descent, we move to the first improving neighbour
        break;
      }
    }

    if (!improved) {
      console.log(`\n  No improvement in iteration ${iter}. Converged.`);
      break;
    }
  }

  // Final report
  console.log("\n=== Optimization Complete ===");
  console.log(`Baseline accuracy: ${(baselineResult.accuracy * 100).toFixed(1)}%`);
  console.log(`Optimized accuracy: ${(bestAccuracy * 100).toFixed(1)}%`);
  console.log(`Improvement: +${((bestAccuracy - baselineResult.accuracy) * 100).toFixed(1)}pp`);
  console.log(`\nOptimal weights:`);
  console.log(JSON.stringify(bestConfig, null, 2));

  const output = {
    baseline: {
      weights: DEFAULT_WEIGHTS,
      accuracy: baselineResult.accuracy,
    },
    optimized: {
      weights: bestConfig,
      accuracy: bestAccuracy,
    },
    improvement: bestAccuracy - baselineResult.accuracy,
    history,
    timestamp: new Date().toISOString(),
    note: "Review variance and consider hold-out validation before applying to DEFAULT_SCORING_CONFIG.",
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${OUTPUT_PATH}`);
}

main().catch((e: unknown) => {
  console.error(`FATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
