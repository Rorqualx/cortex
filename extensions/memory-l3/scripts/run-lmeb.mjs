#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// run-lmeb.mjs — LMEB-style embedding-provider gate for the memory-l3 seam
//
// Paper motivation: arXiv LMEB "Long-horizon Memory Embedding Benchmark"
// (Zhao et al., v2 Aug 2026) — MTEB-style passage retrieval does not measure
// what memory-augmented agent systems need. This harness scores embedding
// providers on the task L3 actually performs: retrieving the right memory
// chunk out of an accumulated long-horizon corpus.
//
// Method: hold-out self-retrieval probes over the live L2 chunk corpus (or a
// deterministic synthetic corpus when --synthetic=N is given). For each
// sampled chunk, a query is built from its most distinctive terms; the gold
// result is the chunk itself. Each candidate provider embeds corpus + probes;
// we rank by cosine similarity and report recall@1 / recall@k / MRR.
//
// Providers (comma-separated --providers= list, spec syntax):
//   hash:<dim>                 deterministic offline hashing embedder (always
//                              available; the baseline sanity lane — no network)
//   openai-compatible:<model>  POSTs {LMEB_BASE_URL:-https://api.openai.com/v1}
//                              /embeddings with LMEB_API_KEY / OPENAI_API_KEY
//
// Output: console table + JSON written beside the LongMemEval outputs
// (/tmp/longmemeval/lmeb-result-<ts>.json by default, or --out=).
//
// Usage:
//   node extensions/memory-l3/scripts/run-lmeb.mjs                       # hash baseline on live L2
//   node extensions/memory-l3/scripts/run-lmeb.mjs --providers=hash:512,openai-compatible:text-embedding-3-small
//   node extensions/memory-l3/scripts/run-lmeb.mjs --synthetic=200       # no live corpus needed
//
// Gate policy: a provider swap should not regress recall@5 vs. the incumbent
// lane before it is promoted through getMemoryEmbeddingProvider.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const argVal = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : null;
};

const HOME = os.homedir();
const DEFAULT_L2_DIR = path.join(HOME, ".openclaw", "workspace", ".openclaw", "l3", "l2");
const OUT_DIR = "/tmp/longmemeval";

// ── Tokenization + probe construction (pure, unit-tested) ────────────────────

const STOPWORDS = new Set(
  (
    "a an and are as at be by for from has have i in is it its of on or that the this to was were will with " +
    "you your we our they their he she his her not no yes but if then than so do does did done can could should " +
    "would may might must about into over under after before during between out up down off again further"
  ).split(" "),
);

export function tokenizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Build one hold-out probe query from a document's most distinctive terms.
 * Distinctive = highest term frequency in the doc, longest terms preferred on
 * ties (stable, deterministic). Gold result is the document itself.
 */
export function buildProbeQuery(docText, maxTerms = 6) {
  const tokens = tokenizeText(docText);
  const tf = new Map();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  const ranked = [...tf.entries()].sort(
    (a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1),
  );
  const terms = ranked.slice(0, maxTerms).map(([t]) => t);
  return terms.join(" ");
}

// ── Offline hashing embedder (baseline lane, pure, unit-tested) ─────────────

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic hashed bag-of-words embedding, L2-normalized. */
export function hashEmbed(text, dim = 256) {
  const vec = new Float64Array(dim);
  for (const token of tokenizeText(text)) {
    vec[fnv1a(token) % dim] += 1;
  }
  let norm = 0;
  for (const v of vec) {
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  return norm > 0 ? Array.from(vec, (v) => v / norm) : Array.from(vec);
}

export function cosineSim(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ── Ranking metrics (pure, unit-tested) ──────────────────────────────────────

/** recall@1, recall@k and MRR for one query whose gold doc sits at `goldRank` (1-based). */
export function rankMetrics(goldRank, k = 5) {
  return {
    recallAt1: goldRank === 1 ? 1 : 0,
    recallAtK: goldRank >= 1 && goldRank <= k ? 1 : 0,
    reciprocalRank: goldRank >= 1 ? 1 / goldRank : 0,
  };
}

// ── Provider resolution ──────────────────────────────────────────────────────

export function parseProviderSpec(spec) {
  const colon = spec.indexOf(":");
  if (colon === -1) {
    throw new Error(`Invalid provider spec "${spec}" (expected kind:model)`);
  }
  const kind = spec.slice(0, colon);
  const model = spec.slice(colon + 1);
  if (kind !== "hash" && kind !== "openai-compatible") {
    throw new Error(`Unknown provider kind "${kind}" in "${spec}"`);
  }
  return { kind, model };
}

async function embedWithProvider(spec, texts) {
  const { kind, model } = parseProviderSpec(spec);
  if (kind === "hash") {
    const dim = Number.parseInt(model, 10);
    if (!Number.isFinite(dim) || dim < 8) {
      throw new Error(`hash provider dim must be an integer >= 8, got "${model}"`);
    }
    return texts.map((t) => hashEmbed(t, dim));
  }
  const apiKey = process.env.LMEB_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("openai-compatible lane needs LMEB_API_KEY or OPENAI_API_KEY");
  }
  const base = (process.env.LMEB_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const vectors = [];
  const BATCH = 64;
  for (let i = 0; i < texts.length; i += BATCH) {
    const resp = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: texts.slice(i, i + BATCH) }),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }
    const json = JSON.parse(await resp.text());
    for (const row of json.data) {
      vectors[i + row.index] = row.embedding;
    }
  }
  return vectors;
}

// ── Corpus loading ───────────────────────────────────────────────────────────

function loadL2Corpus(dir) {
  const docs = [];
  if (!existsSync(dir)) {
    return docs;
  }
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    const raw = readFileSync(path.join(dir, file), "utf8");
    // Strip YAML frontmatter; the body is the retrievable text.
    const body = raw.startsWith("---\n") ? raw.replace(/^---\n[\s\S]*?\n---\n/, "") : raw;
    if (body.trim().length >= 80) {
      docs.push({ id: file, text: body.trim() });
    }
  }
  return docs;
}

function syntheticCorpus(n) {
  // Deterministic pseudo-corpus: distinct topical vocabularies per doc so the
  // offline lane has a learnable retrieval signal.
  const topics = [
    "docker compose port mapping",
    "pi-hole dns upstream resolver",
    "greenhouse thermal mass wall",
    "rust borrow checker lifetime",
    "japan rail pass itinerary",
    "vitest shard worker isolation",
    "prisma migration shadow db",
    "firetv rooting recovery image",
    "manga panel layout gutters",
    "denver winter pipe insulation",
  ];
  return Array.from({ length: n }, (_, i) => {
    const topic = topics[i % topics.length].split(" ");
    const filler = Array.from({ length: 30 }, (_, j) => `${topic[j % topic.length]}${i}`).join(" ");
    return { id: `synthetic-${i}.md`, text: `${topics[i % topics.length]} ${filler}` };
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const providersArg = argVal("providers") ?? "hash:256";
  const providers = providersArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const syntheticN = argVal("synthetic") ? Number.parseInt(argVal("synthetic"), 10) : 0;
  const l2Dir = argVal("corpus") ?? DEFAULT_L2_DIR;
  const k = argVal("k") ? Number.parseInt(argVal("k"), 10) : 5;
  const probeLimit = argVal("probes") ? Number.parseInt(argVal("probes"), 10) : 40;
  const outPath =
    argVal("out") ??
    path.join(OUT_DIR, `lmeb-result-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  let docs = syntheticN > 0 ? syntheticCorpus(syntheticN) : loadL2Corpus(l2Dir);
  if (docs.length < 10) {
    console.log(
      `Corpus too small (${docs.length} docs at ${syntheticN > 0 ? "synthetic" : l2Dir}); falling back to synthetic=100`,
    );
    docs = syntheticCorpus(100);
  }
  // Deterministic probe sample: every docs.length/probeLimit-th doc.
  const stride = Math.max(1, Math.floor(docs.length / probeLimit));
  const probes = [];
  for (let i = 0; i < docs.length && probes.length < probeLimit; i += stride) {
    const query = buildProbeQuery(docs[i].text);
    if (query) {
      probes.push({ query, goldIndex: i });
    }
  }

  console.log(`# LMEB embedding-provider gate`);
  console.log(`Corpus: ${docs.length} docs · probes: ${probes.length} · k=${k}`);
  console.log(`Providers: ${providers.join(", ")}`);

  const results = [];
  for (const spec of providers) {
    const t0 = Date.now();
    let docVecs;
    let queryVecs;
    try {
      docVecs = await embedWithProvider(
        spec,
        docs.map((d) => d.text),
      );
      queryVecs = await embedWithProvider(
        spec,
        probes.map((p) => p.query),
      );
    } catch (e) {
      console.log(`  ${spec.padEnd(44)} ERROR: ${e.message}`);
      results.push({ spec, error: e.message });
      continue;
    }
    let r1 = 0;
    let rk = 0;
    let mrr = 0;
    for (let qi = 0; qi < probes.length; qi++) {
      const scores = docVecs.map((dv, di) => ({ di, s: cosineSim(queryVecs[qi], dv) }));
      scores.sort((a, b) => b.s - a.s);
      const goldRank = scores.findIndex((x) => x.di === probes[qi].goldIndex) + 1;
      const m = rankMetrics(goldRank, k);
      r1 += m.recallAt1;
      rk += m.recallAtK;
      mrr += m.reciprocalRank;
    }
    const n = probes.length || 1;
    const metrics = {
      recallAt1: Number((r1 / n).toFixed(4)),
      recallAtK: Number((rk / n).toFixed(4)),
      mrr: Number((mrr / n).toFixed(4)),
    };
    console.log(
      `  ${spec.padEnd(44)} R@1=${metrics.recallAt1.toFixed(2)} R@${k}=${metrics.recallAtK.toFixed(2)} MRR=${metrics.mrr.toFixed(2)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
    results.push({ spec, corpus: docs.length, probes: probes.length, k, ...metrics });
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  const payload = {
    timestamp: new Date().toISOString(),
    harness: "run-lmeb.mjs",
    source: "arXiv LMEB (Zhao et al., v2 2026-08) — long-horizon memory embedding gate",
    results,
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
}

// Entry-point guard: importing this module (e.g. from unit tests) must not run
// the gate; only a direct `node run-lmeb.mjs` invocation does.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`FATAL: ${e.message}`);
    process.exitCode = 1;
  });
}
