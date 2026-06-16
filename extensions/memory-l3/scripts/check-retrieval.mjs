#!/usr/bin/env node
// Validate hierarchical-l3 retrieval against the live workspace's L2 chunks.
// Usage:  node extensions/memory-l3/scripts/check-retrieval.mjs "your query"
// Defaults to a Davos-themed query if none given.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const QUERY = process.argv.slice(2).join(" ").trim() || "where does my pi-hole live";
const WORKSPACE_DIR = path.join(os.homedir(), ".openclaw", "workspace");
const L3_ROOT = path.join(WORKSPACE_DIR, ".openclaw", "l3");
const L2_DIR = path.join(L3_ROOT, "l2");
const L3_DIR = path.join(L3_ROOT, "l3");

const SCORING = {
  weightLexical: 0.6,
  weightImportance: 0.2,
  weightRecency: 0.1,
  weightL3Boost: 0.1,
  recencyHalfLifeDays: 7,
};

function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersect = 0;
  for (const t of a) {
    if (b.has(t)) intersect += 1;
  }
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function recencyScore(ageMs, halfLifeDays) {
  if (halfLifeDays <= 0) {
    return 1;
  }
  const ageDays = Math.max(0, ageMs) / (1000 * 60 * 60 * 24);
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

function readFrontmatter(file) {
  const raw = readFileSync(file, "utf8");
  if (!raw.startsWith("---\n")) {
    return null;
  }
  const closeAt = raw.indexOf("\n---\n", 4);
  if (closeAt < 0) {
    return null;
  }
  return JSON.parse(raw.slice(4, closeAt));
}

function listL2Chunks() {
  if (!existsSync(L2_DIR)) {
    return [];
  }
  const out = [];
  for (const partition of readdirSync(L2_DIR).toSorted()) {
    const partitionDir = path.join(L2_DIR, partition);
    for (const file of readdirSync(partitionDir).toSorted()) {
      if (file.endsWith(".md")) {
        out.push(path.join(partitionDir, file));
      }
    }
  }
  return out;
}

function listL3Epochs() {
  if (!existsSync(L3_DIR)) {
    return [];
  }
  return readdirSync(L3_DIR)
    .filter((f) => f.endsWith(".md"))
    .toSorted()
    .map((f) => path.join(L3_DIR, f));
}

function chunkSeq(chunkId) {
  const m = /^chunk-(\d+)/.exec(chunkId);
  return m ? Number.parseInt(m[1], 10) : null;
}

function buildEpochBoostMap(queryTokens) {
  const ranges = [];
  for (const file of listL3Epochs()) {
    const fm = readFrontmatter(file);
    if (!fm) {
      continue;
    }
    const epochText = (fm.representativeFacts ?? []).map((f) => f.text).join(" ");
    const score = jaccard(queryTokens, tokenize(epochText));
    if (score <= 0) {
      continue;
    }
    const startSeq = chunkSeq(fm.startChunkId);
    const endSeq = chunkSeq(fm.endChunkId);
    if (startSeq === null || endSeq === null) {
      continue;
    }
    ranges.push({ start: startSeq, end: endSeq, score });
  }
  return ranges;
}

function l3BoostFor(chunkId, ranges) {
  const seq = chunkSeq(chunkId);
  if (seq === null) {
    return 0;
  }
  let best = 0;
  for (const range of ranges) {
    if (seq >= range.start && seq <= range.end && range.score > best) {
      best = range.score;
    }
  }
  return best;
}

const queryTokens = tokenize(QUERY);
if (queryTokens.size === 0) {
  console.error("Query produced no tokens after normalization.");
  process.exit(1);
}

const now = Date.now();
const epochRanges = buildEpochBoostMap(queryTokens);
const scored = [];

for (const file of listL2Chunks()) {
  const fm = readFrontmatter(file);
  if (!fm) {
    continue;
  }
  const l3Boost = l3BoostFor(fm.id, epochRanges);
  for (const fact of fm.facts ?? []) {
    const factTokens = tokenize(fact.text);
    const lexical = jaccard(queryTokens, factTokens);
    const importance = fact.importance ?? 0;
    const recency = recencyScore(now - (fact.createdAt ?? now), SCORING.recencyHalfLifeDays);
    const score =
      lexical * SCORING.weightLexical +
      importance * SCORING.weightImportance +
      recency * SCORING.weightRecency +
      l3Boost * SCORING.weightL3Boost;
    if (score > 0) {
      scored.push({ fact, score, lexical, importance, recency, l3Boost, chunkId: fm.id });
    }
  }
}

scored.sort((a, b) => b.score - a.score);

const TOP_K = 5;
const top = scored.slice(0, TOP_K);

console.log(`L3 root:   ${L3_ROOT}`);
console.log(`Query:     ${QUERY}`);
console.log(`Tokens:    ${[...queryTokens].toSorted().join(" ")}`);
console.log(`Chunks:    ${listL2Chunks().length}  Epochs: ${listL3Epochs().length}`);
console.log(`Scored:    ${scored.length}`);
console.log("");
console.log(`Top ${top.length}:`);
for (const r of top) {
  console.log(
    `  [${r.score.toFixed(3)}] (lex=${r.lexical.toFixed(2)} imp=${r.importance.toFixed(2)} rec=${r.recency.toFixed(2)} l3=${r.l3Boost.toFixed(2)})`,
  );
  console.log(`     ${r.fact.dedupKey}`);
  console.log(`     ${r.fact.text.slice(0, 200)}`);
}
