#!/usr/bin/env node
// Temporal-expression survival audit (QW4, 2026-10-08 — Sleeping Agent,
// arXiv:2608.11775 measurement slice).
//
// QW-A extension (2026-10-11, LAPSE Finding 2 delta): also scores ASPECTUAL
// FLATTENING — matched-pair survival of progressive/habitual/expired verb
// forms pre→post compaction, alongside the timestamp-anchor table. The
// structured temporal_aspect field (PROMPT_VERSION=20) makes the distinction
// addressable; this metric verifies the wording actually survives.
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
//     [--root=<l3 dir>] [--limit=N] [--since=<epoch-ms|ISO|0>] [--verbose]
//
// QW-A loss attribution (2026-11-28): after the base tables, a second
// section audits the CURRENT pipeline only — chunks compacted after the
// v18 timestamp-preservation clause landed (created_at >= --since, default
// the d4e5dc4fadb landing) — with the pre-side denominator de-noised
// (ambient tool-output/system/runtime-context timestamps excluded) and
// every LOST anchor attributed: retained-earlier (cross-chunk dedup drop,
// not a net loss), retained-later (re-extracted, not a net loss), or
// extraction-lost (gone from the store — the true memory loss).
//
// Root resolution: --root → <cwd>/.openclaw/l3 → ~/.openclaw/workspace/.openclaw/l3.
// Output: survival table (overall + per category) and, with --verbose, a
// per-chunk breakdown. Verdict line compares against the 90% bar. Never
// writes to the store; safe to run against a live gateway.

import { readFile, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  attributionForLostAnchor,
  denoisedTextFromLines,
  parseSince,
  V18_LANDED_AT,
} from "./temporal-attribution.mjs";

// Temporal-anchor regexes — MIRRORED from src/compression/temporal.ts with
// the `g` flag added for extraction (keep in sync; all run in linear time).
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?Z?/g;
const SLASH_DATE_RE = /\d{4}\/\d{2}\/\d{2}|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const CLOCK_TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi;
const MONTH_NAME_RE =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\b\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;

// Aspectual verb-form regexes (QW-A, 2026-10-11 — LAPSE Finding 2 delta):
// matched-pair survival of progressive/habitual/expired wording pre→post,
// complementing the timestamp-anchor table above. Aspectual flattening
// ("is migrating" → "migrated") is invisible to timestamp regexes; these
// catch it. All patterns run in linear time (no nested quantifiers).
// Progressive: auxiliary + participle; the matched pair is the PARTICIPLE —
// its loss (base-form rewrite) is the flattening signal.
const PROGRESSIVE_RE = /\b(?:is|are|was|were|am|be|been|being)\s+([a-z]+ing)\b/g;
// Habitual recurrence markers; pair = the whole phrase ("every tuesday").
const HABITUAL_RE =
  /\bevery\s+(?:other\s+)?(?:day|week|month|year|weekend|morning|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
// Expired-state markers; pair = the marker itself ("used to", "no longer").
const EXPIRED_RE = /\b(?:used to|no longer|stopped|formerly)\b/gi;

const CATEGORIES = [
  { name: "iso-date", re: ISO_DATE_RE },
  { name: "slash-date", re: SLASH_DATE_RE },
  { name: "clock-time", re: CLOCK_TIME_RE },
  { name: "month-day", re: MONTH_NAME_RE },
];

const ASPECT_CATEGORIES = [
  { name: "progressive", re: PROGRESSIVE_RE, capture: 1 },
  { name: "habitual", re: HABITUAL_RE, capture: 0 },
  { name: "expired", re: EXPIRED_RE, capture: 0 },
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

/** Extract { category → Set<form> } aspectual verb forms (QW-A).
 * Progressive pairs on the participle (capture 1); habitual/expired pair on
 * the whole match, lowercased so case drift alone never counts as loss. */
function extractAspectForms(text) {
  const byCategory = new Map();
  for (const { name, re, capture } of ASPECT_CATEGORIES) {
    const forms = new Set();
    for (const m of text.matchAll(re)) {
      const form = (capture === 1 ? m[1] : m[0]).trim().toLowerCase();
      if (form) forms.add(form);
    }
    byCategory.set(name, forms);
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
const SINCE = parseSince(argVal("since"));
if (SINCE === null) {
  console.error(
    `error: --since=${argVal("since")} is not an epoch-ms or ISO date (use --since=0 to audit all chunks)`,
  );
  process.exit(1);
}

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

// Load every L2 chunk once: distilled post text (same postHaystack the base
// audit scores against), creation time, deterministic-extractor flag, and
// merged-fact text — the attribution pass below reuses these in memory.
const posts = new Map(); // chunkId → { createdAt, post, deterministic, mergedText }
for (const row of db.prepare("SELECT id, created_at, frontmatter, body FROM l3_l2_chunks").all()) {
  let fm = {};
  try {
    fm = JSON.parse(row.frontmatter);
  } catch {
    fm = {};
  }
  const mergedParts = [];
  for (const fact of fm.facts ?? []) {
    if (
      typeof fact?.text === "string" &&
      typeof fact?.reasoning === "string" &&
      fact.reasoning.startsWith("merged:")
    ) {
      mergedParts.push(fact.text);
    }
  }
  posts.set(row.id, {
    createdAt: row.created_at,
    post: postHaystack(row.frontmatter, row.body),
    deterministic: fm.deterministic === true,
    mergedText: mergedParts.join("\n"),
  });
}
db.close();

// category → { survived, total }; overall accumulates per-chunk distinct anchors.
const stats = new Map(CATEGORIES.map(({ name }) => [name, { survived: 0, total: 0 }]));
// QW-A: aspectual-form stats, same shape (matched-pair survival per class).
const aspectStats = new Map(ASPECT_CATEGORIES.map(({ name }) => [name, { survived: 0, total: 0 }]));
let chunksWithAspects = 0;
const chunkRows = [];
let unpaired = 0;
let chunksWithAnchors = 0;

for (const file of archiveFiles) {
  const chunkId = file.replace(/\.jsonl$/, "");
  const chunk = posts.get(chunkId);
  if (!chunk) {
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
  const post = chunk.post;
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
  // QW-A: aspectual matched-pair survival for the same chunk. Pair = the
  // participle (progressive) or marker phrase (habitual/expired); survival =
  // the exact form appears in the distilled output. A progressive participle
  // rewritten as base/past form counts as LOST — that is the flattening.
  const aspects = extractAspectForms(pre);
  const postLower = post.toLowerCase();
  let chunkAspectTotal = 0;
  for (const [category, forms] of aspects) {
    const s = aspectStats.get(category);
    for (const form of forms) {
      s.total += 1;
      chunkAspectTotal += 1;
      if (postLower.includes(form)) {
        s.survived += 1;
      }
    }
  }
  if (chunkAspectTotal > 0) {
    chunksWithAspects += 1;
  }
}

// --- QW-A (2026-11-28): loss attribution on the v18+ slice, de-noised pre side ---
// The base tables keep their historical inputs (all chunks, noisy pre side)
// so the longitudinal ledger numbers stay comparable. This pass answers
// the follow-up: for the CURRENT pipeline — chunks compacted after the v18
// preservation clause landed — with ambient noise removed from the
// denominator, where do lost anchors actually die?
const sliceLabel = SINCE > 0 ? new Date(SINCE).toISOString() : "all (--since=0)";
const sliceChunks = [];
for (const file of archiveFiles) {
  const chunkId = file.replace(/\.jsonl$/, "");
  const chunk = posts.get(chunkId);
  if (chunk && (SINCE <= 0 || chunk.createdAt >= SINCE)) {
    sliceChunks.push({ file, chunkId, chunk });
  }
}
const attr = {
  denoisedTotal: 0,
  denoisedSurvived: 0,
  noisyTotal: 0,
  noisySurvived: 0,
  retainedEarlier: 0,
  retainedLater: 0,
  extractionLostLlm: 0,
  extractionLostDeterministic: 0,
  mergedPreserved: 0,
  aspectTotal: 0,
  aspectSurvived: 0,
};
// Memoized per-anchor scan: sorted createdAts of chunks whose distilled
// output contains the anchor. The anchor was already confirmed absent from
// the owner chunk's own output, so every entry is another chunk.
const containingCache = new Map();
const containingCreatedAts = (anchor) => {
  let list = containingCache.get(anchor);
  if (list === undefined) {
    list = [];
    for (const c of posts.values()) {
      if (c.post.includes(anchor)) list.push(c.createdAt);
    }
    list.sort((a, b) => a - b);
    containingCache.set(anchor, list);
  }
  return list;
};
for (const { file, chunk } of sliceChunks) {
  let raw = "";
  try {
    raw = await readFile(path.join(archiveDir, file), "utf8");
  } catch {
    continue;
  }
  const lines = raw.split(/\r?\n/);
  const noisyPre = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return messageText(JSON.parse(l));
      } catch {
        return "";
      }
    })
    .join("\n");
  const denoisedPre = denoisedTextFromLines(lines);

  const post = chunk.post;
  for (const set of extractAnchors(noisyPre).values()) {
    for (const anchor of set) {
      attr.noisyTotal += 1;
      if (post.includes(anchor)) attr.noisySurvived += 1;
    }
  }
  const postLower = post.toLowerCase();
  for (const set of extractAnchors(denoisedPre).values()) {
    for (const anchor of set) {
      attr.denoisedTotal += 1;
      if (post.includes(anchor)) {
        attr.denoisedSurvived += 1;
        if (chunk.mergedText.includes(anchor)) attr.mergedPreserved += 1;
      } else {
        const kind = attributionForLostAnchor(chunk.createdAt, containingCreatedAts(anchor));
        if (kind === "retained-earlier") attr.retainedEarlier += 1;
        else if (kind === "retained-later") attr.retainedLater += 1;
        else if (chunk.deterministic) attr.extractionLostDeterministic += 1;
        else attr.extractionLostLlm += 1;
      }
    }
  }
  for (const set of extractAspectForms(denoisedPre).values()) {
    for (const form of set) {
      attr.aspectTotal += 1;
      if (postLower.includes(form)) attr.aspectSurvived += 1;
    }
  }
}

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

// QW-A aspectual-flattening table (matched-pair verb-form survival).
let aspectTotalAll = 0;
let aspectSurvivedAll = 0;
const perAspect = [];
for (const { name } of ASPECT_CATEGORIES) {
  const s = aspectStats.get(name);
  aspectTotalAll += s.total;
  aspectSurvivedAll += s.survived;
  perAspect.push({ category: name, survived: s.survived, total: s.total });
}
console.log("");
console.log(
  `aspectual survival (matched-pair; chunks with aspectual forms: ${chunksWithAspects}):`,
);
console.log("aspect        survived/total  survival");
for (const c of perAspect) {
  console.log(
    `${c.category.padEnd(13)} ${String(c.survived).padStart(4)}/${String(c.total).padEnd(6)}    ${pct(c.survived, c.total) ?? "n/a"}`,
  );
}
console.log(
  `ASPECT OVERALL: ${aspectSurvivedAll}/${aspectTotalAll} aspectual forms survived = ${pct(aspectSurvivedAll, aspectTotalAll) ?? "n/a"} — lost forms = aspectual flattening (progressive/habitual wording rewritten under compaction)`,
);

// QW-A attribution section (2026-11-28).
console.log("");
console.log("== QW-A loss attribution (v18+ slice, de-noised pre side) ==");
console.log(
  `slice: ${sliceChunks.length} chunks created_at >= ${sliceLabel}` +
    (SINCE > 0
      ? ` (default: v18 landed d4e5dc4fadb ${V18_LANDED_AT}; override with --since=<epoch|ISO> or --since=0)`
      : ""),
);
console.log(
  `pre-side anchors: ${attr.denoisedTotal} de-noised (noisy baseline: ${attr.noisyTotal}; ambient = tool/system/openclaw-runtime records + non-text blocks excluded)`,
);
console.log(
  `slice survival: ${attr.denoisedSurvived}/${attr.denoisedTotal} = ${pct(attr.denoisedSurvived, attr.denoisedTotal) ?? "n/a"} de-noised | noisy baseline ${attr.noisySurvived}/${attr.noisyTotal} = ${pct(attr.noisySurvived, attr.noisyTotal) ?? "n/a"}`,
);
const attrLost = attr.denoisedTotal - attr.denoisedSurvived;
console.log(`attribution of ${attrLost} lost anchors:`);
console.log(
  `  retained-earlier (cross-chunk dedup drop — anchor lives in an earlier chunk; NOT a net memory loss): ${attr.retainedEarlier}`,
);
console.log(
  `  retained-later (re-extracted after this chunk — NOT a net memory loss): ${attr.retainedLater}`,
);
console.log(
  `  extraction-lost (llm extraction/merge; category budget off by default): ${attr.extractionLostLlm}`,
);
console.log(`  extraction-lost (deterministic extractor): ${attr.extractionLostDeterministic}`);
console.log(`  anchors preserved inside merged facts: ${attr.mergedPreserved}`);
console.log(
  `slice aspectual survival (de-noised): ${attr.aspectSurvived}/${attr.aspectTotal} = ${pct(attr.aspectSurvived, attr.aspectTotal) ?? "n/a"}`,
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
