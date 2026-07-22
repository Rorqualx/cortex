#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// sweep-weights.mjs — Gradient-free weight optimization for L3 scoring config
//
// Paper: arXiv:2606.12945 — Multi-factor value model V(m) = Σ w_i f_i(m)
// Approach: coordinate descent over the ScoringConfig weight space, using
// the existing LongMemEval engine harness (run-longmemeval-engine.ts) as
// the objective. Each candidate config is run via ZENBRAIN_SCORING_JSON,
// scored by the LLM-judge (score-longmemeval.mjs), and the best config is
// tracked.
//
// This is a *driver* script — it spawns the engine runner as a child process
// for each weight candidate. It does NOT import production code directly.
//
// Usage:
//   node extensions/memory-l3/scripts/sweep-weights.mjs \
//     --oracle=/tmp/longmemeval/oracle.json \
//     --limit=30 --stratified=5 --concurrency=2 \
//     --cache=/tmp/longmemeval/cache \
//     --rounds=3
//
// Output:
//   /tmp/longmemeval/sweep-result.json — best config + per-round history
//
// Requires: ZAI_API_KEY (or auth-profiles), Ollama on localhost:11434.
// ────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";

// ─── Config ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const argVal = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : null;
};

const ORACLE = argVal("oracle") ?? "/tmp/longmemeval/oracle.json";
const LIMIT = argVal("limit") ?? "10";
const STRATIFIED = argVal("stratified") ?? "5";
const CONCURRENCY = argVal("concurrency") ?? "1";
const CACHE = argVal("cache") ?? "/tmp/longmemeval/cache";
const ROUNDS = parseInt(argVal("rounds") ?? "3", 10);
const OUT_DIR = argVal("out") ?? "/tmp/longmemeval";
const ENGINE = "extensions/memory-l3/scripts/run-longmemeval-engine.ts";

// Weight parameters to sweep. Each entry: [key, min, max, stepFraction]
// stepFraction controls how much we move per round relative to the range.
const SWEEP_PARAMS = [
  ["weightLexical", 0.05, 0.45],
  ["weightBm25", 0.05, 0.5],
  ["weightImportance", 0.05, 0.3],
  ["weightRecency", 0.01, 0.2],
  ["weightSemantic", 0.1, 0.55],
  ["weightInformationGain", 0.0, 0.15],
  ["weightGoalRelevance", 0.0, 0.2],
  ["weightReliability", 0.0, 0.2],
  ["weightSemanticEntropy", 0.0, 0.2],
];

// Starting config (current production defaults).
const BASELINE = {
  weightLexical: 0.25,
  weightBm25: 0.3,
  weightImportance: 0.15,
  weightRecency: 0.05,
  weightL3Boost: 0.1,
  weightLongTermTierBoost: 0.15,
  weightMemoryCoreTierMultiplier: 0.7,
  weightTypedFactTierBoost: 0.1,
  recencyHalfLifeDays: 7,
  useFsrs: true,
  weightSemantic: 0.35,
  weightInformationGain: 0.05,
  weightGoalRelevance: 0.1,
  weightReliability: 0.1,
  weightSemanticEntropy: 0.1,
};

// ─── Engine ─────────────────────────────────────────────────────────────────

/**
 * Run the LongMemEval engine with a given scoring config override.
 * Returns { exactMatchPct, answerInContextPct, label } from the run metadata.
 */
async function runEngine(config, roundIdx, paramIdx, label) {
  const scoringJson = JSON.stringify(config);
  const env = {
    ...process.env,
    ZENBRAIN_SCORING_JSON: scoringJson,
  };

  const tag = `sweep-r${roundIdx}-p${paramIdx}-${label}`;
  const proc = spawn(
    "node",
    [
      "--import",
      "tsx",
      ENGINE,
      `--oracle=${ORACLE}`,
      `--limit=${LIMIT}`,
      `--stratified=${STRATIFIED}`,
      `--concurrency=${CONCURRENCY}`,
      `--cache=${CACHE}`,
    ],
    {
      env,
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => {
    stdout += d;
  });
  proc.stderr.on("data", (d) => {
    stderr += d;
  });

  const code = await new Promise((resolve) => {
    proc.on("close", resolve);
  });

  if (code !== 0) {
    console.error(`  [FAIL] ${tag}: exit ${code}\n${stderr.slice(-500)}`);
    return { exactMatchPct: 0, answerInContextPct: 0, label: tag, error: true };
  }

  // Parse the overall line from stdout
  // Example: "  OVERALL                     7/10 (70%)  AIC:8/10 (80%)"
  const overallMatch = stdout.match(/OVERALL\s+\S+\s+\((\d+)%\)\s+AIC:\S+\s+\((\d+)%\)/);
  if (!overallMatch) {
    console.error(`  [PARSE] ${tag}: could not find OVERALL in output`);
    return { exactMatchPct: 0, answerInContextPct: 0, label: tag, error: true };
  }

  return {
    exactMatchPct: parseInt(overallMatch[1], 10),
    answerInContextPct: parseInt(overallMatch[2], 10),
    label: tag,
  };
}

/**
 * Objective function: maximize exact-match %, with AIC as tiebreaker.
 */
function score(result) {
  return result.exactMatchPct * 100 + result.answerInContextPct;
}

// ─── Coordinate descent ─────────────────────────────────────────────────────

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(CACHE, { recursive: true }).catch(() => {});

  console.log("=== L3 Scoring Weight Sweep ===");
  console.log(`Oracle: ${ORACLE}`);
  console.log(`Rounds: ${ROUNDS}, Questions/round: ${LIMIT} (stratified ${STRATIFIED})`);
  console.log(`Params to sweep: ${SWEEP_PARAMS.map((p) => p[0]).join(", ")}`);
  console.log();

  let bestConfig = { ...BASELINE };
  let bestResult = null;
  let bestScore = -Infinity;
  const history = [];

  // Round 0: baseline
  console.log("[Round 0] Baseline (current production defaults)...");
  const baselineResult = await runEngine(BASELINE, 0, 0, "baseline");
  bestResult = baselineResult;
  bestScore = score(baselineResult);
  history.push({ round: 0, config: BASELINE, result: baselineResult, score: bestScore });
  console.log(
    `  Baseline: EM=${baselineResult.exactMatchPct}% AIC=${baselineResult.answerInContextPct}% → score=${bestScore}`,
  );

  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`\n[Round ${round}] Coordinate descent over ${SWEEP_PARAMS.length} params...`);

    for (let pi = 0; pi < SWEEP_PARAMS.length; pi++) {
      const [key, lo, hi] = SWEEP_PARAMS[pi];
      const range = hi - lo;
      const current = bestConfig[key] ?? lo;

      // Try +step and -step
      const stepSize = range * 0.3; // 30% of range per step
      const candidates = [Math.max(lo, current - stepSize), Math.min(hi, current + stepSize)];

      for (const val of candidates) {
        const trialConfig = { ...bestConfig, [key]: val };
        const trialResult = await runEngine(trialConfig, round, pi, `${key}=${val.toFixed(3)}`);
        const trialScore = score(trialResult);
        console.log(
          `  ${key}=${val.toFixed(3)} → EM=${trialResult.exactMatchPct}% AIC=${trialResult.answerInContextPct}% score=${trialScore}`,
        );

        if (trialScore > bestScore) {
          bestScore = trialScore;
          bestConfig = trialConfig;
          bestResult = trialResult;
          console.log(
            `    ↑ NEW BEST (Δ=${(trialScore - history[history.length - 1].score).toFixed(0)})`,
          );
        }

        history.push({
          round,
          paramIdx: pi,
          key,
          value: val,
          config: trialConfig,
          result: trialResult,
          score: trialScore,
        });
      }
    }

    console.log(
      `\n[Round ${round}] Best so far: EM=${bestResult.exactMatchPct}% AIC=${bestResult.answerInContextPct}% score=${bestScore}`,
    );
  }

  // ─── Report ──────────────────────────────────────────────────────────────
  const report = {
    baseline: { config: BASELINE, result: history[0].result, score: history[0].score },
    best: { config: bestConfig, result: bestResult, score: bestScore },
    improvement: {
      exactMatchPct: bestResult.exactMatchPct - history[0].result.exactMatchPct,
      answerInContextPct: bestResult.answerInContextPct - history[0].result.answerInContextPct,
      scoreDelta: bestScore - history[0].score,
    },
    rounds: ROUNDS,
    questionsPerRound: LIMIT,
    history: history.map((h) => ({
      round: h.round,
      key: h.key ?? "baseline",
      value: h.value,
      score: h.score,
      exactMatchPct: h.result.exactMatchPct,
      answerInContextPct: h.result.answerInContextPct,
    })),
  };

  const outPath = path.join(OUT_DIR, "sweep-result.json");
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`\n=== Sweep complete ===`);
  console.log(`Best config saved to ${outPath}`);
  console.log(
    `Baseline: EM=${report.baseline.result.exactMatchPct}% → Best: EM=${report.best.result.exactMatchPct}% (+${report.improvement.exactMatchPct}%)`,
  );
  console.log(`\nTo apply: copy best.config into DEFAULT_SCORING_CONFIG in scoring.ts`);
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
