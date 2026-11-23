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
// QW1 extension (2026-11-22, arXiv:2609.36457): ORDER FIDELITY — for anchor
// pairs that survive within the SAME post-chunk, compare relative order
// pre vs post compaction; report the inversion rate beside survival.
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
import { pathToFileURL } from "node:url";

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

// Loss-taxonomy regexes (QW3, 2026-11-22 — Sleeping-Agent loss taxonomy,
// arXiv:2608.11775): matched-pair survival of the three detail classes most
// frequently lost under compression. All patterns run in linear time (no
// nested quantifiers) and mirror src/compression/loss-taxonomy.ts.
// Quantities: number + unit (compact "250ms" or spaced "4 TB"), pair = the
// whole matched string. Trailing lookahead instead of \b — \b never holds
// after "%". Mirrors src/compression/loss-taxonomy.ts.
const QUANTITY_RE =
  /\b\d+(?:\.\d+)?\s*(?:tb|gb|mb|kb|b|km|mi|m|cm|ft|in|kg|g|ms|s|h|hr|hrs|min|days?|weeks?|months?|years?|usd|eur|gbp|dollars|cents|%|x)(?![a-z0-9])/gi;
// Negations: pair = the negation marker itself.
const NEGATION_RE =
  /\b(?:not|never|no longer|cannot|can't|don't|doesn't|didn't|won't|wouldn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't)\b/gi;
// Entity–attribute bindings: proper-noun possessor + attribute, pair = the
// whole phrase ("Huey's disk") — losing the binding reattaches the value.
const ENTITY_BINDING_RE = /\b[A-Z][A-Za-z0-9]*'s\s+[A-Za-z][a-zA-Z0-9-]+/g;

const LOSS_CATEGORIES = [
  { name: "quantity", re: QUANTITY_RE, capture: 0 },
  { name: "negation", re: NEGATION_RE, capture: 0 },
  { name: "entity-binding", re: ENTITY_BINDING_RE, capture: 0 },
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

/** Extract { category → Set<form> } loss-taxonomy forms (QW3): quantities,
 * negation markers, and entity–attribute bindings. Whole-match pairs,
 * lowercased so case drift alone never counts as loss. Exported for tests. */
export function extractLossForms(text) {
  const byCategory = new Map();
  for (const { name, re } of LOSS_CATEGORIES) {
    const forms = new Set();
    for (const m of text.matchAll(re)) {
      const form = m[0].trim().toLowerCase();
      if (form) forms.add(form);
    }
    byCategory.set(name, forms);
  }
  return byCategory;
}

// QW1 (2026-11-22, arXiv:2609.36457): cap on anchors entering the pairwise
// order comparison — pairs grow O(n²) and pathological chunks (logs dumps
// full of clock times) would otherwise dominate the audit.
const MAX_ORDER_ANCHORS = 20;

/** Order fidelity (QW1): given the anchors that SURVIVED into the same
 * post-chunk, compare their relative order pre vs post. Returns the number
 * of comparable pairs and how many flipped. Cross-chunk ordering is
 * deliberately not measured (ambiguous — chunk merge order is not temporal
 * order); each chunk contributes only within-chunk pairs. */
export function countOrderInversions(anchors, preText, postText) {
  const positions = [];
  for (const anchor of anchors) {
    const preIdx = preText.indexOf(anchor);
    const postIdx = postText.indexOf(anchor);
    if (preIdx < 0 || postIdx < 0) continue; // not a surviving pair
    positions.push({ anchor, preIdx, postIdx });
  }
  positions.sort((a, b) => a.preIdx - b.preIdx);
  const bounded = positions.slice(0, MAX_ORDER_ANCHORS);
  let pairs = 0;
  let inversions = 0;
  for (let i = 0; i < bounded.length; i++) {
    for (let j = i + 1; j < bounded.length; j++) {
      pairs += 1;
      // Sorted by preIdx, so i precedes j pre-compaction; an inversion is
      // j surfacing BEFORE i post-compaction. Tied postIdx (one anchor a
      // substring of another at the same spot) counts as preserved.
      if (bounded[j].postIdx < bounded[i].postIdx) inversions += 1;
    }
  }
  return { pairs, inversions };
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

async function main() {
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
  // QW-A: aspectual-form stats, same shape (matched-pair survival per class).
  const aspectStats = new Map(
    ASPECT_CATEGORIES.map(({ name }) => [name, { survived: 0, total: 0 }]),
  );
  // QW3: loss-taxonomy stats, same shape (matched-pair survival per class).
  const lossStats = new Map(LOSS_CATEGORIES.map(({ name }) => [name, { survived: 0, total: 0 }]));
  let chunksWithLossForms = 0;
  // QW1: within-chunk order fidelity of surviving anchor pairs.
  let orderPairs = 0;
  let orderInversions = 0;
  let chunksWithOrderPairs = 0;
  let chunksWithAspects = 0;
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
    const survivingAnchors = [];
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
          survivingAnchors.push(anchor);
        }
      }
    }
    // QW1: relative order of surviving anchors, pre vs post (within-chunk
    // pairs only — cross-chunk order is not measured).
    const order = countOrderInversions(survivingAnchors, pre, post);
    orderPairs += order.pairs;
    orderInversions += order.inversions;
    if (order.pairs > 0) {
      chunksWithOrderPairs += 1;
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
    // QW3: loss-taxonomy matched-pair survival — quantities (with unit),
    // negation markers, and entity–attribute bindings. Survival = the exact
    // form appears in the distilled output; a rounded quantity, dropped
    // negation, or reattached binding counts as LOST.
    const lossForms = extractLossForms(pre);
    let chunkLossTotal = 0;
    for (const [category, forms] of lossForms) {
      const s = lossStats.get(category);
      for (const form of forms) {
        s.total += 1;
        chunkLossTotal += 1;
        if (postLower.includes(form)) {
          s.survived += 1;
        }
      }
    }
    if (chunkLossTotal > 0) {
      chunksWithLossForms += 1;
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

  // QW1 order-fidelity table (2026-11-22, arXiv:2609.36457): within-chunk
  // pairs of surviving anchors whose relative order flipped under compaction.
  console.log("");
  console.log(
    `order fidelity (within-chunk surviving pairs; chunks with pairs: ${chunksWithOrderPairs}):`,
  );
  console.log(
    `ORDER: ${orderInversions}/${orderPairs} pairs inverted = ${pct(orderInversions, orderPairs) ?? "n/a"} — inversions are temporal reordering under compaction (cross-chunk ordering not measured; ties count as preserved)`,
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

  // QW3 loss-taxonomy table (matched-pair survival of bindings/quantities/
  // negations, 2026-11-22).
  let lossTotalAll = 0;
  let lossSurvivedAll = 0;
  const perLoss = [];
  for (const { name } of LOSS_CATEGORIES) {
    const s = lossStats.get(name);
    lossTotalAll += s.total;
    lossSurvivedAll += s.survived;
    perLoss.push({ category: name, survived: s.survived, total: s.total });
  }
  console.log("");
  console.log(
    `loss-taxonomy survival (matched-pair; chunks with loss forms: ${chunksWithLossForms}):`,
  );
  console.log("class          survived/total  survival");
  for (const c of perLoss) {
    console.log(
      `${c.category.padEnd(14)} ${String(c.survived).padStart(4)}/${String(c.total).padEnd(6)}    ${pct(c.survived, c.total) ?? "n/a"}`,
    );
  }
  console.log(
    `LOSS OVERALL: ${lossSurvivedAll}/${lossTotalAll} loss-taxonomy forms survived = ${pct(lossSurvivedAll, lossTotalAll) ?? "n/a"} — lost forms = corrupted memory (reattached bindings, rounded quantities, inverted negations)`,
  );

  if (overall !== null) {
    const verdict =
      overall >= 0.9
        ? "PASS — survival ≥ 90%; temporal preservation is holding (close the loop with this number)"
        : "BELOW 90% — tighten the extraction/compaction temporal rules and re-run";
    console.log(`VERDICT: ${verdict}`);
  } else {
    console.log(
      "VERDICT: no temporal anchors found in pre-compaction messages — nothing to measure",
    );
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
}

// Direct-run guard: importing the module (tests) must not execute the audit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
