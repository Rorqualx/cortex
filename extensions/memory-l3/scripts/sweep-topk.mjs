#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// sweep-topk.mjs — Accuracy-vs-budget (topK) sweep for L3 retrieval
//
// Source: daily analysis 2026-10-15, Quick Win 1 (finding 9) — LongMemEval
// budget sweep. Runs the existing engine harness (run-longmemeval-engine.ts)
// at several retrieval budgets (--topk), sharing one ingested-store cache so
// each budget pays only the cheap consolidate+retrieve+answer phase, then
// scores each run with the calibrated LLM-judge (score-longmemeval.mjs) and
// writes an accuracy-vs-budget curve.
//
// This is a *driver* script — it spawns the engine runner and the judge as
// child processes. It does NOT import production code directly.
//
// Usage:
//   node extensions/memory-l3/scripts/sweep-topk.mjs \
//     --oracle=/tmp/longmemeval/oracle.json \
//     --limit=5 --stratified=5 --concurrency=2 \
//     --cache=/tmp/longmemeval/cache \
//     --budgets=5,10,20,40,full
//
// Output:
//   /tmp/longmemeval/budget-sweep-result.json — per-budget curve + judge scores
//
// Requires: ZAI_API_KEY (or auth-profiles), Ollama on localhost:11434.
// ────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const ENGINE = "extensions/memory-l3/scripts/run-longmemeval-engine.ts";
const JUDGE = "extensions/memory-l3/scripts/score-longmemeval.mjs";

// ─── Pure helpers (exported for unit tests) ─────────────────────────────────

/**
 * Parse and validate a --budgets list ("5,10,20,40,full").
 * Returns tokens in the order given; throws on invalid entries so a typo
 * fails fast instead of silently skipping a budget point.
 */
export function parseBudgets(raw) {
  const tokens = String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("No budgets given");
  }
  for (const t of tokens) {
    if (t !== "full" && !/^\d+$/.test(t)) {
      throw new Error(`Invalid budget token: ${t} (expected <int> or "full")`);
    }
    if (t !== "full" && Number.parseInt(t, 10) < 1) {
      throw new Error(`Budget must be >= 1: ${t}`);
    }
  }
  // de-dup while preserving order (first occurrence wins)
  return [...new Set(tokens)];
}

/** Parse the engine's OVERALL stdout line: `OVERALL  7/10 (70%)  AIC:8/10 (80%)`. */
export function parseEngineOverall(stdout) {
  const m = String(stdout).match(/OVERALL\s+\S+\s+\((\d+)%\)\s+AIC:\S+\s+\((\d+)%\)/);
  if (!m) return null;
  return { exactMatchPct: Number(m[1]), answerInContextPct: Number(m[2]) };
}

/** Parse the judge's OVERALL stdout line: `OVERALL  7/10 (70%)`. */
export function parseJudgeOverall(stdout) {
  const m = String(stdout).match(/OVERALL\s+(\d+)\/(\d+)\s+\((\d+)%\)/);
  if (!m) return null;
  return { hits: Number(m[1]), total: Number(m[2]), pct: Number(m[3]) };
}

/** Extract the first `Wrote <path>` file path from engine stdout (hypothesis jsonl). */
export function parseWroteHypothesis(stdout) {
  const m = String(stdout).match(/Wrote\s+(\S+)/);
  return m ? m[1] : null;
}

/** Parse the engine's token/cost line for the curve's cost columns. */
export function parseTokenLine(stdout) {
  const m = String(stdout).match(/tokens: (\d+) \(in (\d+) \/ out (\d+)\) · est cost \$([0-9.]+)/);
  if (!m) return null;
  return {
    totalTokens: Number(m[1]),
    promptTokens: Number(m[2]),
    completionTokens: Number(m[3]),
    estimatedCostUsd: Number(m[4]),
  };
}

// ─── Driver ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const argVal = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : null;
};

const ORACLE = argVal("oracle") ?? "/tmp/longmemeval/oracle.json";
const LIMIT = argVal("limit") ?? "5";
const STRATIFIED = argVal("stratified") ?? "5";
const CONCURRENCY = argVal("concurrency") ?? "1";
const CACHE = argVal("cache") ?? "/tmp/longmemeval/cache";
const BUDGETS = parseBudgets(argVal("budgets") ?? "5,10,20,40,full");
const OUT_DIR = argVal("out") ?? "/tmp/longmemeval";
const RUN_JUDGE = argVal("judge") !== "0";

function runCapture(cmd, cmdArgs, env = process.env) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, cmdArgs, {
      env,
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function sweepBudget(budget) {
  const t0 = Date.now();
  console.log(`\n── budget topK=${budget} ──`);
  const engineArgs = [
    "--import",
    "tsx",
    ENGINE,
    `--oracle=${ORACLE}`,
    `--limit=${LIMIT}`,
    `--stratified=${STRATIFIED}`,
    `--concurrency=${CONCURRENCY}`,
    `--cache=${CACHE}`,
    `--topk=${budget}`,
  ];
  const engine = await runCapture("node", engineArgs);
  if (engine.code !== 0) {
    console.error(`  [FAIL] engine exit ${engine.code}\n${engine.stderr.slice(-500)}`);
    return { budget, error: `engine exit ${engine.code}` };
  }
  const overall = parseEngineOverall(engine.stdout);
  const tokens = parseTokenLine(engine.stdout);
  if (!overall) {
    console.error(`  [PARSE] no OVERALL line in engine output`);
    return { budget, error: "no OVERALL line" };
  }
  const row = {
    budget,
    exactMatchPct: overall.exactMatchPct,
    answerInContextPct: overall.answerInContextPct,
    ...tokens,
    wallClockMin: Number(((Date.now() - t0) / 60000).toFixed(1)),
  };

  if (RUN_JUDGE) {
    const hypoPath = parseWroteHypothesis(engine.stdout);
    if (!hypoPath) {
      row.judgeError = "hypothesis path not found";
    } else {
      const judge = await runCapture("node", [JUDGE, hypoPath]);
      if (judge.code !== 0) {
        row.judgeError = `judge exit ${judge.code}`;
      } else {
        const judged = parseJudgeOverall(judge.stdout);
        if (judged) {
          row.judgePct = judged.pct;
          row.judgeHits = judged.hits;
          row.judgeTotal = judged.total;
        } else {
          row.judgeError = "no judge OVERALL line";
        }
      }
    }
  }
  console.log(
    `  exact=${row.exactMatchPct}% AIC=${row.answerInContextPct}%` +
      (row.judgePct !== undefined ? ` judge=${row.judgePct}%` : "") +
      ` tokens=${row.totalTokens ?? "?"} cost=$${row.estimatedCostUsd ?? "?"}`,
  );
  return row;
}

async function main() {
  console.log(`# LongMemEval budget sweep — budgets: ${BUDGETS.join(",")}`);
  console.log(`oracle=${ORACLE} limit=${LIMIT} stratified=${STRATIFIED} cache=${CACHE}`);
  const rows = [];
  for (const b of BUDGETS) {
    rows.push(await sweepBudget(b));
  }

  console.log(`\n=== Accuracy-vs-budget curve ===`);
  console.log(
    `  ${"budget".padEnd(8)} ${"exact".padStart(6)} ${"AIC".padStart(6)} ${"judge".padStart(6)}  tokens`,
  );
  for (const r of rows) {
    console.log(
      `  ${String(r.budget).padEnd(8)} ${String(r.exactMatchPct ?? "-").padStart(6)} ${String(
        r.answerInContextPct ?? "-",
      ).padStart(6)} ${String(r.judgePct ?? "-").padStart(6)}  ${r.totalTokens ?? "-"}`,
    );
  }

  const outPath = path.join(OUT_DIR, "budget-sweep-result.json");
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        oracle: ORACLE,
        limit: LIMIT,
        stratified: STRATIFIED,
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nWrote ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
