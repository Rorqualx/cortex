#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// prompt-prefix-tax-audit.mjs — R1 per-turn re-prefill tax audit
//
// Source: self-improvement-lab card 9e633f3e (ARCH-3 byte-exact KV-state
// caching), plan stage 2026-10-15 §B. Consumes a JSONL feed captured from the
// real prompt-build path (see probe/prompt-cache-capture-harness.test.ts for
// the regeneration one-liner) and reports:
//   - suffix re-prefill tax per turn (tokens × (1 − cacheRead/input), n/a
//     when the feed lacks usage telemetry)
//   - Memory Recall share of the dynamic suffix (from capture-time section
//     records — observation snapshots store digests only)
//   - cache-hit ratio, dropCause histogram, boundary-break count
//
// Pure node: builtins only. Read-only over the feed. No network.
//
// Usage:
//   node extensions/memory-l3/scripts/prompt-prefix-tax-audit.mjs \
//     --feed=/tmp/prompt-prefix-feed.jsonl [--out=<md>] [--pricing-in=<usd/M input>]
// ────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from "node:fs";

export const MEMORY_RECALL_SECTION = "Memory Recall";
export const BOUNDARY_BREAK_CAUSES = [
  "tracked-input-change",
  "provider-cache-reuse-lost",
];

/** Parse CLI args of the form --key=value (booleans as --key). */
export function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

/** Parse a JSONL feed into records; throws on malformed lines. */
export function parseFeed(text) {
  const records = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`feed line ${i + 1}: not JSON (${err.message})`);
    }
    if (typeof rec !== "object" || rec === null || typeof rec.turn !== "number") {
      throw new Error(`feed line ${i + 1}: missing numeric "turn"`);
    }
    records.push(rec);
  }
  if (records.length === 0) throw new Error("feed is empty");
  return records;
}

/** Char-based token estimate — same order as capture-time estTokens. */
export function estTokensFromChars(chars) {
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Per-record metrics. Tax is null (rendered "n/a") when usage telemetry is
 * absent — offline feeds carry no cacheRead; the live number lands via R2.
 */
export function computeRecordMetrics(rec, pricingInPerM) {
  const suffixTokens = Number(rec.suffixTokens ?? 0);
  const sections = Array.isArray(rec.sections) ? rec.sections : [];
  const recall = sections
    .filter((s) => s && s.name === MEMORY_RECALL_SECTION)
    .reduce((acc, s) => acc + (Number(s.estTokens) || 0), 0);
  const recallShare =
    suffixTokens > 0 ? recall / suffixTokens : sections.some((s) => s?.name === MEMORY_RECALL_SECTION) ? null : 0;
  const input = Number(rec.input ?? 0);
  const cacheRead = Number(rec.cacheRead ?? 0);
  const hasTelemetry = input > 0 && cacheRead >= 0 && rec.cacheRead !== undefined;
  const cacheHitRatio = hasTelemetry ? cacheRead / input : null;
  const rePrefillTaxTokens = hasTelemetry ? Math.round(suffixTokens * (1 - cacheHitRatio)) : null;
  const costUsd =
    pricingInPerM !== undefined && input > 0
      ? (input * pricingInPerM) / 1e6
      : null;
  const boundaryBreak =
    typeof rec.dropCause === "string" &&
    (BOUNDARY_BREAK_CAUSES.some((c) => rec.dropCause === c) ||
      rec.dropCause.startsWith("provider-cache-reuse-lost:"));
  return {
    turn: rec.turn,
    suffixTokens,
    recallTokens: recall,
    recallShare,
    cacheHitRatio,
    rePrefillTaxTokens,
    costUsd,
    dropCause: rec.dropCause ?? null,
    boundaryBreak,
  };
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function aggregate(records, pricingInPerM) {
  const metrics = records.map((r) => computeRecordMetrics(r, pricingInPerM));
  const suffixes = metrics.map((m) => m.suffixTokens);
  const hitRatios = metrics.filter((m) => m.cacheHitRatio !== null).map((m) => m.cacheHitRatio);
  const taxes = metrics.filter((m) => m.rePrefillTaxTokens !== null).map((m) => m.rePrefillTaxTokens);
  const recallShares = metrics.filter((m) => m.recallShare !== null).map((m) => m.recallShare);
  const histogram = {};
  for (const m of metrics) {
    const key = m.dropCause ?? "(none)";
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return {
    n: metrics.length,
    suffixTokensMean: mean(suffixes),
    suffixTokensMedian: median(suffixes),
    cacheHitRatioMean: hitRatios.length ? mean(hitRatios) : null,
    rePrefillTaxTotal: taxes.length ? taxes.reduce((a, b) => a + b, 0) : null,
    rePrefillTaxMean: mean(taxes),
    recallShareMean: recallShares.length ? mean(recallShares) : null,
    telemetryRecords: hitRatios.length,
    boundaryBreaks: metrics.filter((m) => m.boundaryBreak).length,
    dropCauseHistogram: histogram,
    metrics,
  };
}

export function renderReport(agg, meta) {
  const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const num = (x) => (x === null ? "n/a" : Math.round(x).toLocaleString());
  const lines = [];
  lines.push(`# Prompt Prefix Tax Audit — ${meta.date ?? ""}`.trim());
  lines.push("");
  lines.push(`- Feed: \`${meta.feed}\``);
  lines.push(`- Records: ${agg.n} (usage telemetry on ${agg.telemetryRecords})`);
  if (meta.pricingInPerM !== undefined) lines.push(`- Pricing: $${meta.pricingInPerM}/M input`);
  lines.push("");
  lines.push("| turn | suffix tok | recall tok | recall share | cache hit | tax tok |");
  lines.push("|---|---|---|---|---|---|");
  for (const m of agg.metrics) {
    lines.push(
      `| ${m.turn} | ${num(m.suffixTokens)} | ${num(m.recallTokens)} | ${pct(m.recallShare)} | ${pct(m.cacheHitRatio)} | ${m.rePrefillTaxTokens === null ? "n/a" : num(m.rePrefillTaxTokens)} |`,
    );
  }
  lines.push("");
  lines.push(
    `- Mean suffix: **${num(agg.suffixTokensMean)} tok** (median ${num(agg.suffixTokensMedian)})`,
  );
  lines.push(
    `- Memory Recall share of suffix (mean): **${pct(agg.recallShareMean)}**`,
  );
  lines.push(
    `- Re-prefill tax: **${agg.rePrefillTaxMean === null ? "n/a (no telemetry — upper bound = full suffix)" : `${num(agg.rePrefillTaxMean)} tok/turn (total ${num(agg.rePrefillTaxTotal)})`}**`,
  );
  lines.push(`- Cache-hit ratio (mean): ${pct(agg.cacheHitRatioMean)}`);
  lines.push(`- Boundary breaks: ${agg.boundaryBreaks}`);
  lines.push(`- dropCause histogram: ${JSON.stringify(agg.dropCauseHistogram)}`);
  return lines.join("\n") + "\n";
}

export function main(argv) {
  const args = parseArgs(argv);
  if (!args.feed) {
    console.error("usage: prompt-prefix-tax-audit.mjs --feed=<jsonl> [--out=<md>] [--pricing-in=<usd/M>]");
    process.exitCode = 2;
    return;
  }
  const text = readFileSync(args.feed, "utf8");
  const records = parseFeed(text);
  const pricingInPerM = args["pricing-in"] !== undefined ? Number(args["pricing-in"]) : undefined;
  const agg = aggregate(records, pricingInPerM);
  const report = renderReport(agg, {
    feed: args.feed,
    date: new Date().toISOString().slice(0, 10),
    pricingInPerM,
  });
  process.stdout.write(report);
  if (args.out) writeFileSync(args.out, report, "utf8");
}

if (process.argv[1] && process.argv[1].endsWith("prompt-prefix-tax-audit.mjs")) {
  main(process.argv.slice(2));
}
