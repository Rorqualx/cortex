// optimize-extract-prompt.ts — ARCH-3 Phase 1 probe spike (THROWAWAY 2026-11-20).
// Discrete prompt-variant search over the L3 extraction system prompt, cloning
// the optimize-weights.ts skeleton: same engine spawn (run-longmemeval-engine.ts
// via env ZENBRAIN_SCORING_JSON), same judge (score-longmemeval.mjs), plus the
// ZENBRAIN_EXTRACT_PROMPT_OVERRIDE/TARGET seam resolved inside llm.ts.
// The live search + guards only run when NOT --dryRun; dryRun validates the
// variant table and lists it (zero LLM spend). Output = recommendation JSON;
// adoption (PROMPT_VERSION bump + const replacement) stays operator-side.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type PromptVariant = {
  id: string;
  target: "extract" | "native";
  systemPrompt: string;
};

export type VariantTable = {
  variants: PromptVariant[];
};

export type VariantResult = {
  id: string;
  target: "extract" | "native";
  accuracy: number;
  perType: Record<string, number>;
  guardFailures: string[];
};

export type Recommendation = {
  recommendedVariantId: string | null;
  baselineAccuracy: number | null;
  results: VariantResult[];
  timestamp: string;
  tip: string;
};

export class VariantTableError extends Error {}

/** Load + validate the variant table. Laws (hard fail):
 *  - JSON object with non-empty `variants` array
 *  - index 0 = baseline (id contains "baseline")
 *  - ids unique, target ∈ {extract, native}, systemPrompt non-empty */
export function loadVariantTable(filePath: string): VariantTable {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new VariantTableError(`variant table unreadable: ${filePath} (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new VariantTableError(`variant table is not valid JSON: ${(error as Error).message}`);
  }
  const table = parsed as VariantTable;
  if (!table || !Array.isArray(table.variants) || table.variants.length === 0) {
    throw new VariantTableError("variant table must be an object with a non-empty `variants` array");
  }
  const seen = new Set<string>();
  table.variants.forEach((variant, index) => {
    if (!variant || typeof variant.id !== "string" || !variant.id.trim()) {
      throw new VariantTableError(`variant[${index}]: missing non-empty id`);
    }
    if (seen.has(variant.id)) {
      throw new VariantTableError(`variant[${index}]: duplicate id "${variant.id}"`);
    }
    seen.add(variant.id);
    if (variant.target !== "extract" && variant.target !== "native") {
      throw new VariantTableError(
        `variant[${index}] "${variant.id}": target must be "extract" or "native" (got ${JSON.stringify(variant.target)})`,
      );
    }
    if (typeof variant.systemPrompt !== "string" || !variant.systemPrompt.trim()) {
      throw new VariantTableError(`variant[${index}] "${variant.id}": systemPrompt must be non-empty text`);
    }
  });
  const first = table.variants[0]!;
  if (!first.id.includes("baseline")) {
    throw new VariantTableError(
      `variant[0] must be the baseline (id containing "baseline", got "${first.id}") — baseline-first law`,
    );
  }
  return table;
}

/** Rank by accuracy desc, per-type mean desc as tiebreak. Stable on input order. */
export function rankResults(results: VariantResult[]): VariantResult[] {
  const mean = (perType: Record<string, number>): number => {
    const values = Object.values(perType);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  };
  return [...results].sort((a, b) => b.accuracy - a.accuracy || mean(b.perType) - mean(a.perType));
}

/** Pure recommendation builder. Baseline must be present in results. */
export function buildRecommendation(results: VariantResult[], tip: string): Recommendation {
  const baseline = results.find((r) => r.id.includes("baseline")) ?? null;
  const ranked = rankResults(results);
  const winner = ranked[0] ?? null;
  const disqualified = winner && winner.guardFailures.length > 0;
  return {
    recommendedVariantId: winner && !disqualified ? winner.id : null,
    baselineAccuracy: baseline ? baseline.accuracy : null,
    results: ranked,
    timestamp: new Date().toISOString(),
    tip,
  };
}

// ── Live search (NOT exercised by --dryRun) ────────────────────────────

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const ENGINE_SCRIPT = path.join(SCRIPT_DIR, "run-longmemeval-engine.ts");

const args = process.argv.slice(2);
const argVal = (name: string): string | null => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};

function runVariantEvaluation(variant: PromptVariant, cache: string, stratified: number, concurrency: number, oracle: string) {
  const overrideFile = path.join(cache, `prompt-override-${variant.id}.txt`);
  writeFileSync(overrideFile, variant.systemPrompt, "utf8");
  const engineEnv = {
    ...process.env,
    ZENBRAIN_EXTRACT_PROMPT_OVERRIDE: overrideFile,
    ZENBRAIN_EXTRACT_PROMPT_TARGET: variant.target,
  };
  const engineResult = spawnSync(
    "node",
    ["--import", "tsx", ENGINE_SCRIPT, `--cache=${cache}`, `--stratified=${stratified}`, `--concurrency=${concurrency}`, `--oracle=${oracle}`],
    { env: engineEnv, cwd: REPO_ROOT, encoding: "utf8", timeout: 600_000 },
  );
  if (engineResult.status !== 0) {
    return { accuracy: 0, perType: {} as Record<string, number> };
  }
  const hypoMatch = engineResult.stdout.match(/Wrote (.+hypothesis-engine-.+\.jsonl)/);
  if (!hypoMatch) {
    return { accuracy: 0, perType: {} as Record<string, number> };
  }
  // Judge step mirrors optimize-weights.ts: score-longmemeval.mjs on the
  // hypothesis file; accuracy + per-type parsed from its stdout JSON.
  const judge = spawnSync("node", ["--import", "tsx", path.join(SCRIPT_DIR, "score-longmemeval.mjs"), hypoMatch[1]!], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  try {
    const parsed = JSON.parse(judge.stdout) as { accuracy?: number; perType?: Record<string, number> };
    return { accuracy: parsed.accuracy ?? 0, perType: parsed.perType ?? {} };
  } catch {
    return { accuracy: 0, perType: {} as Record<string, number> };
  }
}

async function main(): Promise<void> {
  const variantsPath = argVal("variants") ?? path.join(SCRIPT_DIR, "extract-prompt-variants.json");
  const dryRun = args.includes("--dryRun");
  const table = loadVariantTable(variantsPath);
  console.log(`Variant table OK: ${table.variants.length} variants from ${variantsPath}`);
  for (const variant of table.variants) {
    console.log(`  - ${variant.id} [${variant.target}] (${variant.systemPrompt.length} chars)`);
  }
  if (dryRun) {
    console.log("DRY-RUN: table validated + listed; no evaluation, no guards, no LLM spend.");
    return;
  }
  // Live search: baseline first (cache warm + reference), then rest within budget.
  const cache = argVal("cache") ?? "/tmp/lme-cache";
  const budget = Number.parseInt(argVal("budget") ?? "8", 10);
  const oracle = argVal("oracle") ?? "/tmp/longmemeval/oracle.json";
  const output = argVal("output") ?? "/tmp/lme-optimal-prompt.json";
  const results: VariantResult[] = [];
  for (const variant of table.variants.slice(0, budget)) {
    console.log(`\nEvaluating ${variant.id} [${variant.target}]...`);
    const { accuracy, perType } = runVariantEvaluation(variant, cache, 5, 2, oracle);
    console.log(`  accuracy=${accuracy.toFixed(4)}`);
    results.push({ id: variant.id, target: variant.target, accuracy, perType, guardFailures: [] });
  }
  // Guards on top-2 (repeated-compaction + temporal-survival with variant env
  // vs baseline env) are implement-stage work; probe validates invocability only.
  const recommendation = buildRecommendation(results, "probe-tip");
  writeFileSync(output, JSON.stringify(recommendation, null, 2), "utf8");
  console.log(`\nRecommendation written to ${output} (recommended=${recommendation.recommendedVariantId})`);
}

// Main guard: unit tests import the pure helpers without triggering the CLI.
if (process.argv[1] && path.resolve(process.argv[1]!) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
