#!/usr/bin/env node
// Temporal-expression survival audit (QW4, 2026-10-08 — Sleeping Agent,
// arXiv:2608.11775 measurement slice).
//
// Read-only diagnostic: measures what fraction of explicit temporal anchors
// (ISO dates/timestamps, slash dates, clock times, month-day references) in
// PRE-compaction messages (`l1_archive/<chunkId>.jsonl`) survive into the
// POST-compaction L2 chunk (`l3_l2_chunks` frontmatter facts/typedFacts +
// body in `l3.sqlite`). The preservation prompt rule (EXTRACT_SYSTEM_PROMPT
// TEMPORAL clause, PROMPT_VERSION=18) and the deterministic counterpart
// (src/compression/temporal.ts) already ship — this script closes the loop
// with a recorded survival number.
//
// Usage:
//   node extensions/memory-l3/scripts/temporal-survival-audit.mjs \
//     [--root=<l3 dir>] [--limit=N] [--verbose]
//
// Root resolution: --root → <cwd>/.openclaw/l3 → ~/.openclaw/workspace/.openclaw/l3.
// Output: survival table (overall + per category) and, with --verbose, a
// per-chunk breakdown. Verdict line compares against the 90% bar. Never
// writes to the store; safe to run against a live gateway.

import { readFile, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Temporal-anchor regexes — MIRRORED from src/compression/temporal.ts with
// the `g` flag added for extraction (keep in sync; all run in linear time).
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?Z?/g;
const SLASH_DATE_RE = /\d{4}\/\d{2}\/\d{2}|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const CLOCK_TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi;
const MONTH_NAME_RE =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\b\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;

const CATEGORIES = [
  { name: "iso-date", re: ISO_DATE_RE },
  { name: "slash-date", re: SLASH_DATE_RE },
  { name: "clock-time", re: CLOCK_TIME_RE },
  { name: "month-day", re: MONTH_NAME_RE },
];

/** Extract { category → Set<anchor> } from text. Later categories run on text
 * masked of earlier matches so e.g. the clock time inside an ISO timestamp is
 * not double-counted. */
function extractAnchors(text) {
  let masked = text;
  const byCategory = new Map();
  for (const { name, re } of CATEGORIES) {
    const anchors = new Set();
    for (const m of masked.matchAll(re)) {
      const anchor = m[0].trim();
      if (anchor) anchors.add(anchor);
    }
    byCategory.set(name, anchors);
    masked = masked.replace(re, " ");
  }
  return byCategory;
}

/** Flatten an l1-archive message record to plain text (role + content blocks). */
function messageText(record) {
  const parts = [];
  if (typeof record?.role === "string") parts.push(record.role);
  const content = record?.content;
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Concatenate the distilled (post-compaction) content of an L2 chunk row:
 * prose fact texts + reasoning, typed slot/value/unit/sourceSpan, and body. */
function postHaystack(frontmatterJson, body) {
  let fm;
  try {
    fm = JSON.parse(frontmatterJson);
  } catch {
    fm = {};
  }
  const parts = [typeof body === "string" ? body : ""];
  for (const fact of fm.facts ?? []) {
    if (typeof fact?.text === "string") parts.push(fact.text);
    if (typeof fact?.reasoning === "string") parts.push(fact.reasoning);
  }
  for (const typed of fm.typedFacts ?? []) {
    for (const key of ["slot", "value", "unit", "sourceSpan"]) {
      const v = typed?.[key];
      if (typeof v === "string") parts.push(v);
    }
  }
  return parts.join("\n");
}

const args = process.argv.slice(2);
const argVal = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : null;
};
const VERBOSE = args.includes("--verbose");
const LIMIT = Number.parseInt(argVal("limit") ?? "0", 10);

async function resolveRoot() {
  const explicit = argVal("root");
  if (explicit) return explicit;
  const cwdCandidate = path.join(process.cwd(), ".openclaw", "l3");
  try {
    await readdir(cwdCandidate);
    return cwdCandidate;
  } catch {
    return path.join(os.homedir(), ".openclaw", "workspace", ".openclaw", "l3");
  }
}

const root = await resolveRoot();
const archiveDir = path.join(root, "l1_archive");
const dbPath = path.join(root, "l3.sqlite");

let archiveFiles;
try {
  archiveFiles = (await readdir(archiveDir)).filter((f) => f.endsWith(".jsonl")).sort();
} catch {
  console.error(`error: no l1_archive directory under ${root} — pass --root=<l3 dir>`);
  process.exit(1);
}
if (LIMIT > 0) archiveFiles = archiveFiles.slice(0, LIMIT);

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch {
  console.error(`error: cannot open ${dbPath} read-only`);
  process.exit(1);
}

const selectChunk = db.prepare("SELECT frontmatter, body FROM l3_l2_chunks WHERE id = ?");

// category → { survived, total }; overall accumulates per-chunk distinct anchors.
const stats = new Map(CATEGORIES.map(({ name }) => [name, { survived: 0, total: 0 }]));
const chunkRows = [];
let unpaired = 0;
let chunksWithAnchors = 0;

for (const file of archiveFiles) {
  const chunkId = file.replace(/\.jsonl$/, "");
  const row = selectChunk.get(chunkId);
  if (!row) {
    unpaired += 1;
    continue;
  }
  let pre = "";
  try {
    const raw = await readFile(path.join(archiveDir, file), "utf8");
    pre = raw
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return messageText(JSON.parse(l));
        } catch {
          return "";
        }
      })
      .join("\n");
  } catch {
    unpaired += 1;
    continue;
  }

  const anchors = extractAnchors(pre);
  const post = postHaystack(row.frontmatter, row.body);
  let chunkTotal = 0;
  let chunkSurvived = 0;
  for (const [category, set] of anchors) {
    const s = stats.get(category);
    for (const anchor of set) {
      s.total += 1;
      chunkTotal += 1;
      // Substring survival: the exact anchor string appears in the distilled
      // output. Generic clock times can false-positive across long outputs;
      // acceptable for an audit-grade metric.
      if (post.includes(anchor)) {
        s.survived += 1;
        chunkSurvived += 1;
      }
    }
  }
  if (chunkTotal > 0) {
    chunksWithAnchors += 1;
    if (VERBOSE) {
      chunkRows.push({
        chunkId,
        survival: chunkTotal === 0 ? null : chunkSurvived / chunkTotal,
        survived: chunkSurvived,
        total: chunkTotal,
      });
    }
  }
}
db.close();

let totalAll = 0;
let survivedAll = 0;
const perCategory = [];
for (const { name } of CATEGORIES) {
  const s = stats.get(name);
  totalAll += s.total;
  survivedAll += s.survived;
  perCategory.push({ category: name, survived: s.survived, total: s.total });
}

const pct = (n, d) => (d === 0 ? null : `${((100 * n) / d).toFixed(1)}%`);
const overall = totalAll === 0 ? null : survivedAll / totalAll;

console.log(`temporal-survival-audit — root: ${root}`);
console.log(
  `chunks audited: ${archiveFiles.length - unpaired} (unpaired: ${unpaired}, with temporal anchors: ${chunksWithAnchors})`,
);
console.log("");
console.log("category      survived/total  survival");
for (const c of perCategory) {
  console.log(
    `${c.category.padEnd(13)} ${String(c.survived).padStart(4)}/${String(c.total).padEnd(6)}    ${pct(c.survived, c.total) ?? "n/a"}`,
  );
}
console.log("");
console.log(
  `OVERALL: ${survivedAll}/${totalAll} distinct temporal anchors survived = ${pct(survivedAll, totalAll) ?? "n/a"}`,
);

if (overall !== null) {
  const verdict =
    overall >= 0.9
      ? "PASS — survival ≥ 90%; temporal preservation is holding (close the loop with this number)"
      : "BELOW 90% — tighten the extraction/compaction temporal rules and re-run";
  console.log(`VERDICT: ${verdict}`);
} else {
  console.log("VERDICT: no temporal anchors found in pre-compaction messages — nothing to measure");
}

if (VERBOSE && chunkRows.length > 0) {
  console.log("");
  console.log("per-chunk (worst 10):");
  chunkRows
    .toSorted((a, b) => a.survival - b.survival)
    .slice(0, 10)
    .forEach((r) =>
      console.log(`  ${r.chunkId}  ${r.survived}/${r.total} = ${(100 * r.survival).toFixed(1)}%`),
    );
}
