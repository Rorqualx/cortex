#!/usr/bin/env node
// Retrieval correlation report (ARCH-2 v1, 2026-11-11 — MemCon log-first lane,
// card 9b9efeea). Joins `retrieval_events` (written fire-and-forget at both
// engine injection lanes) against terminal run outcomes keyed on session_key,
// then buckets by intentClass × preset with success-rate math and an
// unjoined-rate honesty line. Read-only against the store unless --prune-days
// is given (then it deletes only retrieval_events rows; never facts).
//
// Outcomes come from either the DB (`retrieval_outcomes`, upserted by the
// offline outcome lane) or a JSONL file (--outcomes=<path>, one
// {sessionKey, ts, ok, detail?} per line) — both lanes produce identical
// buckets by construction (tested).
//
// Usage:
//   node extensions/memory-l3/scripts/retrieval-correlation-report.mjs \
//     --db=<l3.sqlite> [--outcomes=<jsonl>] [--since-days=30] \
//     [--min-n=5] [--out=<md>] [--prune-days=90]
//
// Exit 0 on success. Explicit --db required (sandbox-HOME gotcha: never
// resolve against a vitest-sandboxed HOME).

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** @typedef {{ts:number, sessionId:string, sessionKey?:string|null, intentClass?:string|null, preset?:string|null, topK?:number|null, factIds:string[], estTokens?:number|null, source:string}} TelemetryEvent */
/** @typedef {{sessionKey:string, ts:number, ok:boolean, detail?:string|null}} TelemetryOutcome */

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) {
      args[raw.slice(2)] = true;
    } else {
      args[raw.slice(2, eq)] = raw.slice(eq + 1);
    }
  }
  return args;
}

/** Parse a --outcomes JSONL feed (one outcome object per line). */
export function loadOutcomesJsonl(text) {
  const outcomes = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.sessionKey === "string") {
      outcomes.push({
        sessionKey: parsed.sessionKey,
        ts: typeof parsed.ts === "number" ? parsed.ts : 0,
        ok: parsed.ok === true || parsed.ok === 1,
        detail: parsed.detail ?? null,
      });
    }
  }
  return outcomes;
}

function bucketKeyOf(event) {
  const intent = event.intentClass ?? "(none)";
  const preset = event.preset ?? "(none)";
  return `${intent}|${preset}`;
}

/**
 * Pure aggregation: bucket events by intentClass × preset and join to
 * outcomes on sessionKey.
 * @param {TelemetryEvent[]} events
 * @param {TelemetryOutcome[]} outcomes
 */
export function aggregate(events, outcomes) {
  const outcomeBySessionKey = new Map(outcomes.map((o) => [o.sessionKey, o]));
  const buckets = new Map();
  let joinedTotal = 0;
  for (const event of events) {
    const key = bucketKeyOf(event);
    const bucket = buckets.get(key) ?? {
      intentClass: event.intentClass ?? "(none)",
      preset: event.preset ?? "(none)",
      n: 0,
      joined: 0,
      okCount: 0,
      tokenSum: 0,
      tokenCount: 0,
    };
    bucket.n += 1;
    if (typeof event.estTokens === "number") {
      bucket.tokenSum += event.estTokens;
      bucket.tokenCount += 1;
    }
    const outcome = event.sessionKey ? outcomeBySessionKey.get(event.sessionKey) : undefined;
    if (outcome) {
      bucket.joined += 1;
      joinedTotal += 1;
      if (outcome.ok) bucket.okCount += 1;
    }
    buckets.set(key, bucket);
  }
  return {
    buckets: [...buckets.values()]
      .map((b) => ({
        intentClass: b.intentClass,
        preset: b.preset,
        n: b.n,
        joined: b.joined,
        okCount: b.okCount,
        successRate: b.joined > 0 ? b.okCount / b.joined : null,
        meanTokens: b.tokenCount > 0 ? b.tokenSum / b.tokenCount : null,
      }))
      .sort((a, b) => `${a.intentClass}|${a.preset}`.localeCompare(`${b.intentClass}|${b.preset}`)),
    unjoinedRate: events.length > 0 ? 1 - joinedTotal / events.length : 0,
  };
}

/**
 * "Strongest preset per intent" verdict line. Buckets below min-n (or with
 * zero joined outcomes) are excluded — no tiny-n lies.
 * @param {ReturnType<typeof aggregate>["buckets"]} buckets
 */
export function verdictLine(buckets, minN) {
  const byIntent = new Map();
  for (const bucket of buckets) {
    if (bucket.n < minN || bucket.joined === 0 || bucket.successRate === null) continue;
    const current = byIntent.get(bucket.intentClass);
    if (!current || bucket.successRate > current.successRate) {
      byIntent.set(bucket.intentClass, bucket);
    }
  }
  if (byIntent.size === 0) {
    return `verdict: no bucket met min-n=${minN} with a joined outcome — not enough evidence yet`;
  }
  const parts = [...byIntent.entries()].map(
    ([intent, b]) =>
      `${intent}→${b.preset} (success ${(b.successRate * 100).toFixed(0)}%, n=${b.n})`,
  );
  return `verdict: strongest preset per intent — ${parts.join("; ")}`;
}

function openDb(dbPath, { readOnly }) {
  try {
    return new DatabaseSync(dbPath, { readOnly });
  } catch {
    // WAL leftovers can block a readOnly open (-shm absent); a normal open
    // still never writes unless we execute a write statement.
    return new DatabaseSync(dbPath);
  }
}

function rowToEvent(row) {
  return {
    ts: row.ts,
    sessionId: row.session_id,
    sessionKey: row.session_key,
    intentClass: row.intent_class,
    preset: row.preset,
    topK: row.top_k,
    factIds: JSON.parse(row.fact_ids),
    estTokens: row.est_tokens,
    source: row.source,
  };
}

/** Read telemetry events from the l3.sqlite store (ts >= sinceTs when given). */
export function readEventsDb(dbPath, sinceTs) {
  const db = openDb(dbPath, { readOnly: true });
  try {
    const rows =
      sinceTs !== undefined
        ? db.prepare("SELECT * FROM retrieval_events WHERE ts >= ? ORDER BY ts, id").all(sinceTs)
        : db.prepare("SELECT * FROM retrieval_events ORDER BY ts, id").all();
    return rows.map(rowToEvent);
  } finally {
    db.close();
  }
}

/** Read recorded outcomes from the l3.sqlite store. */
export function readOutcomesDb(dbPath) {
  const db = openDb(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT session_key, ts, ok, detail FROM retrieval_outcomes ORDER BY ts")
      .all();
    return rows.map((row) => ({
      sessionKey: row.session_key,
      ts: row.ts,
      ok: row.ok === 1,
      detail: row.detail,
    }));
  } finally {
    db.close();
  }
}

/** Prune events older than beforeTs (only write this script performs). */
export function pruneEventsDb(dbPath, beforeTs) {
  const db = openDb(dbPath, { readOnly: false });
  try {
    const result = db.prepare("DELETE FROM retrieval_events WHERE ts < ?").run(beforeTs);
    return Number(result.changes ?? 0);
  } finally {
    db.close();
  }
}

/** Render the markdown report (bucket table + honesty line + verdict). */
export function renderReport(agg, meta) {
  const lines = [];
  lines.push(`# Retrieval Correlation Report`);
  lines.push("");
  lines.push(
    `- window: since ${meta.sinceDays}d · min-n: ${meta.minN} · outcomes: ${meta.outcomeSource}`,
  );
  lines.push(
    `- unjoined rate: ${(agg.unjoinedRate * 100).toFixed(1)}% (events with no matching outcome — join coverage honesty line)`,
  );
  lines.push("");
  lines.push(`| intent | preset | n | joined | ok | success | mean tokens |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const b of agg.buckets) {
    lines.push(
      `| ${b.intentClass} | ${b.preset} | ${b.n} | ${b.joined} | ${b.okCount} | ${b.successRate === null ? "n/a" : `${(b.successRate * 100).toFixed(0)}%`} | ${b.meanTokens === null ? "n/a" : b.meanTokens.toFixed(0)} |`,
    );
  }
  if (agg.buckets.length === 0) {
    lines.push(`| (no events in window) | | | | | | |`);
  }
  lines.push("");
  lines.push(verdictLine(agg.buckets, meta.minN));
  return lines.join("\n") + "\n";
}

export function main(argv) {
  const args = parseArgs(argv);
  const dbPath = typeof args["db"] === "string" ? args["db"] : "";
  if (!dbPath) {
    process.stderr.write(
      "usage: retrieval-correlation-report.mjs --db=<l3.sqlite> [--outcomes=<jsonl>] [--since-days=30] [--min-n=5] [--out=<md>] [--prune-days=90]\n",
    );
    return 1;
  }
  const sinceDays = Number(args["since-days"] ?? 30);
  const minN = Number(args["min-n"] ?? 5);
  const sinceTs = Date.now() - sinceDays * DAY_MS;
  const events = readEventsDb(dbPath, sinceTs);
  let outcomes;
  let outcomeSource = "db";
  if (typeof args["outcomes"] === "string") {
    outcomes = loadOutcomesJsonl(readFileSync(args["outcomes"], "utf8"));
    outcomeSource = path.basename(args["outcomes"]);
  } else {
    outcomes = readOutcomesDb(dbPath);
  }
  const agg = aggregate(events, outcomes);
  const report = renderReport(agg, { sinceDays, minN, outcomeSource });
  if (typeof args["out"] === "string") {
    writeFileSync(args["out"], report, "utf8");
    process.stdout.write(
      `wrote ${args["out"]} (${events.length} events, ${outcomes.length} outcomes)\n`,
    );
  } else {
    process.stdout.write(report);
  }
  if (args["prune-days"] !== undefined) {
    const pruneDays = Number(args["prune-days"]);
    if (Number.isFinite(pruneDays) && pruneDays > 0) {
      const pruned = pruneEventsDb(dbPath, Date.now() - pruneDays * DAY_MS);
      process.stdout.write(`pruned ${pruned} events older than ${pruneDays}d\n`);
    }
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("retrieval-correlation-report.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
