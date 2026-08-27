#!/usr/bin/env node --import tsx
//
// Cross-Embedding-Model Calibration (arXiv:2608.05857-inspired)
//
// When the embedding provider is swapped (e.g., nomic-embed-text →
// text-embedding-3-small), cosine-similarity distributions shift and
// fixed retrieval thresholds (e.g., RETOPK_SIMILARITY_THRESHOLD) become
// miscalibrated. This script:
//
// 1. Loads existing L2 fact texts from the L3 store.
// 2. Generates synthetic queries (fact-text prefixes + keyword extracts).
// 3. Embeds each query with BOTH the old and new providers.
// 4. Computes pairwise cosine similarities under each model.
// 5. Fits a linear regression mapping old-model thresholds → new-model
//    thresholds (simple, interpretable, monotone-preserving).
// 6. Writes a `threshold_map.json` the engine reads at startup.
//
// ## Usage
//
// ```sh
// node --import tsx extensions/memory-l3/scripts/calibrate-embeddings.ts \
//   --l3root=~/.openclaw/l3 \
//   --old-provider=openai \
//   --old-model=nomic-embed-text \
//   --new-provider=openai \
//   --new-model=text-embedding-3-small \
//   --output=~/.openclaw/l3/threshold_map.json
// ```
//
// ## Output format
//
// ```json
// {
//   "oldModel": "nomic-embed-text",
//   "newModel": "text-embedding-3-small",
//   "calibratedAt": 1723100000000,
//   "sampleCount": 200,
//   "mapping": {
//     "slope": 0.87,
//     "intercept": 0.04,
//     "r2": 0.93
//   },
//   "thresholds": {
//     "0.92": 0.88,
//     "0.85": 0.81,
//     "0.75": 0.71
//   }
// }
// ```
//
// The engine's `loadThresholdMap()` reads this file and adjusts
// similarity comparisons accordingly.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { linearRegression } from "../src/calibration-math.js";
import { cosineSimilarity } from "../src/scoring.js";
import { Storage } from "../src/storage.js";

// ── Types ──────────────────────────────────────────────────────────────

type EmbeddingProvider = {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
};

type ThresholdMap = {
  oldModel: string;
  newModel: string;
  calibratedAt: number;
  sampleCount: number;
  mapping: {
    slope: number;
    intercept: number;
    r2: number;
  };
  thresholds: Record<string, number>;
};

// ── CLI Parsing ────────────────────────────────────────────────────────

function parseArgs(): {
  l3root: string;
  oldProvider: string;
  oldModel: string;
  newProvider: string;
  newModel: string;
  output: string;
  sampleCount: number;
} {
  const args = process.argv.slice(2);
  const get = (key: string, required = true): string => {
    const prefix = `--${key}=`;
    const found = args.find((a) => a.startsWith(prefix));
    if (!found) {
      if (required) {
        console.error(`Missing required argument: --${key}=...`);
        process.exit(1);
      }
      return "";
    }
    let val = found.slice(prefix.length);
    if (val.startsWith("~")) val = resolvePath(homedir(), val.slice(1));
    return val;
  };
  return {
    l3root: get("l3root"),
    oldProvider: get("old-provider"),
    oldModel: get("old-model"),
    newProvider: get("new-provider"),
    newModel: get("new-model"),
    output: get("output", false) || resolvePath(get("l3root"), "threshold_map.json"),
    sampleCount: parseInt(get("sample-count", false) || "200", 10),
  };
}

// ── Synthetic Query Generation ─────────────────────────────────────────

/**
 * Generate a synthetic query from a fact text.
 * Strategy: take the first N significant words as a "query" — simulating
 * how a user might phrase a lookup for this fact.
 */
function syntheticQuery(factText: string): string {
  const words = factText.split(/\s+/).filter((w) => w.length > 3);
  if (words.length <= 4) return factText;
  // Take first 4-6 significant words
  const n = Math.min(6, Math.max(4, Math.floor(words.length / 2)));
  return words.slice(0, n).join(" ");
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  console.log(`[calibrate] Loading facts from ${opts.l3root}...`);

  const storage = new Storage(opts.l3root);
  await storage.ensureLayout();

  // Load L2 chunk facts — canonical reads come from the DB via chunk tokens.
  const chunkTokens = await storage.listL2ChunkPaths();
  const allFacts: string[] = [];
  for (const token of chunkTokens) {
    const chunk = await storage.readL2ChunkAtPath(token);
    if (!chunk) continue;
    for (const fact of chunk.frontmatter.facts) {
      allFacts.push(fact.text);
    }
  }

  if (allFacts.length === 0) {
    console.error("[calibrate] No facts found in L3 store. Nothing to calibrate.");
    process.exit(1);
  }

  // Sample up to sampleCount facts
  const sampled =
    allFacts.length <= opts.sampleCount
      ? allFacts
      : [...allFacts].sort(() => Math.random() - 0.5).slice(0, opts.sampleCount);

  console.log(`[calibrate] Sampled ${sampled.length} facts from ${allFacts.length} total`);

  // Generate synthetic queries
  const queries = sampled.map(syntheticQuery);
  console.log(`[calibrate] Generated ${queries.length} synthetic queries`);

  // Resolve providers via the same core infrastructure the engine uses
  const { getMemoryEmbeddingProvider } =
    await import("openclaw/plugin-sdk/memory-core-host-engine-embeddings");

  // We need the OpenClaw config for provider resolution
  const configPath = resolvePath(homedir(), ".openclaw/openclaw.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    console.warn(`[calibrate] Could not read ${configPath}, using empty config`);
  }

  function makeProvider(providerName: string, modelName: string): EmbeddingProvider {
    const adapter = getMemoryEmbeddingProvider(providerName, config);
    if (!adapter) {
      throw new Error(`Could not resolve embedding provider "${providerName}"`);
    }
    return {
      embed: async (text: string) => {
        const { provider } = await adapter.create({ config, model: modelName });
        if (!provider) throw new Error(`Embedding provider "${providerName}" returned no provider`);
        // Canonical EmbeddingProvider API: queries ride inputType: "query"
        // (the pre-canonical embedQuery API was removed upstream).
        return await provider.embed(text, { inputType: "query" });
      },
      embedBatch: async (texts: string[]) => {
        const { provider } = await adapter.create({ config, model: modelName });
        if (!provider) throw new Error(`Embedding provider "${providerName}" returned no provider`);
        return provider.embedBatch(texts);
      },
    };
  }

  console.log(
    `[calibrate] Embedding ${queries.length} queries with OLD model (${opts.oldModel})...`,
  );
  const oldProvider = makeProvider(opts.oldProvider, opts.oldModel);
  const oldQueryEmbeddings = await oldProvider.embedBatch(queries);
  const oldFactEmbeddings = await oldProvider.embedBatch(sampled);

  console.log(
    `[calibrate] Embedding ${queries.length} queries with NEW model (${opts.newModel})...`,
  );
  const newProvider = makeProvider(opts.newProvider, opts.newModel);
  const newQueryEmbeddings = await newProvider.embedBatch(queries);
  const newFactEmbeddings = await newProvider.embedBatch(sampled);

  // Compute pairwise cosine similarities: query i vs fact i (matching pair)
  // and a sample of non-matching pairs for calibration data
  const oldSims: number[] = [];
  const newSims: number[] = [];

  for (let i = 0; i < queries.length; i++) {
    const oldQ = oldQueryEmbeddings[i];
    const newQ = newQueryEmbeddings[i];
    const oldF = oldFactEmbeddings[i];
    const newF = newFactEmbeddings[i];
    if (!oldQ || !newQ || !oldF || !newF) continue;

    // Matching pair (query i → fact i)
    oldSims.push(cosineSimilarity(oldQ, oldF));
    newSims.push(cosineSimilarity(newQ, newF));

    // A few non-matching pairs for broader distribution
    const offset = (i + 37) % queries.length; // deterministic pseudo-random offset
    if (offset !== i) {
      const oldFOff = oldFactEmbeddings[offset];
      const newFOff = newFactEmbeddings[offset];
      if (!oldFOff || !newFOff) continue;
      oldSims.push(cosineSimilarity(oldQ, oldFOff));
      newSims.push(cosineSimilarity(newQ, newFOff));
    }
  }

  console.log(`[calibrate] Computed ${oldSims.length} similarity pairs`);

  // Fit linear regression: newSim = slope * oldSim + intercept
  const regression = linearRegression(oldSims, newSims);
  console.log(
    `[calibrate] Regression: slope=${regression.slope.toFixed(4)}, intercept=${regression.intercept.toFixed(4)}, R²=${regression.r2.toFixed(4)}`,
  );

  // Map common thresholds
  const commonThresholds = [0.92, 0.85, 0.75, 0.65, 0.5];
  const thresholds: Record<string, number> = {};
  for (const t of commonThresholds) {
    thresholds[t.toFixed(2)] = Math.max(
      0,
      Math.min(1, regression.slope * t + regression.intercept),
    );
  }

  const map: ThresholdMap = {
    oldModel: opts.oldModel,
    newModel: opts.newModel,
    calibratedAt: Date.now(),
    sampleCount: sampled.length,
    mapping: regression,
    thresholds,
  };

  // Write output
  const outPath = opts.output;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(map, null, 2));
  console.log(`[calibrate] Wrote threshold map to ${outPath}`);
  console.log("[calibrate] Threshold mappings:");
  for (const [old, newVal] of Object.entries(thresholds)) {
    console.log(`  ${old} → ${newVal.toFixed(4)}`);
  }
}

main().catch((err: unknown) => {
  console.error("[calibrate] Fatal:", err);
  process.exit(1);
});
