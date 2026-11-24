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
// QW2 extension (2026-11-24, Finding 1 residual): adds the paper's core
// measurements for the GIST-ABSTRACTION path, which the L1→L2 extraction
// slice could not see. (1) Pre/post EXPRESSION-COUNT check: occurrence-level
// counts of temporal expressions in the raw pre-compaction messages vs the
// distilled output — density loss, not just distinct-anchor survival.
// (2) L2-facts → merged/abstracted-output survival slice: the compaction
// operators (compaction.ts applyCategoryBudgetWithOperators — textual merge
// and LLM abstraction) mark their output facts with reasoning "merged:N" /
// "abstract:N"; this audit partitions the persisted L2 facts by those markers
// and scores temporal-anchor survival into each partition separately. The
// paper's claim is that abstraction is where temporal info dies — this is
// the slice that watches it. Pure helpers are exported (with a .d.mts
// companion) so temporal-survival-audit.test.ts can regression-lock them;
// the CLI body is guarded so importing the module does not run the audit.
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
import { fileURLToPath } from "node:url";

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
export function extractAnchors(text) {
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

/** Occurrence-level temporal-expression counts per category (QW2, 2026-11-24).
 * The Sleeping Agent paper's pre/post expression-count check: counts EVERY
 * occurrence (not distinct anchors) so dropping one of two mentions of the
 * same date reads as density loss even though the anchor "survives". Masking
 * order matches extractAnchors. */
export function countTemporalExpressions(text) {
  let masked = text;
  const perCategory = new Map();
  let total = 0;
  for (const { name, re } of CATEGORIES) {
    let count = 0;
    for (const _m of masked.matchAll(re)) {
      count += 1;
    }
    perCategory.set(name, count);
    total += count;
    masked = masked.replace(re, " ");
  }
  return { perCategory, total };
}

/** Extract { category → Set<form> } aspectual verb forms (QW-A).
 * Progressive pairs on the participle (capture 1); habitual/expired pair on
 * the whole match, lowercased so case drift alone never counts as loss. */
export function extractAspectForms(text) {
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
export function messageText(record) {
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
export function postHaystack(frontmatterJson, body) {
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

/** Partition an L2 chunk's persisted prose facts by compaction-operator marker
 * (QW2, 2026-11-24). compaction.ts stamps textual-merge output with reasoning
 * "merged:N" and LLM-abstraction output with "abstract:N"; everything else is
 * a plain extracted fact. Returns joined text per partition so the audit can
 * score temporal-anchor survival into the abstraction path separately. */
export function partitionFactsByOperatorOutput(frontmatterJson) {
  let fm;
  try {
    fm = JSON.parse(frontmatterJson);
  } catch {
    fm = {};
  }
  const plain = [];
  const merged = [];
  const abstract = [];
  for (const fact of fm.facts ?? []) {
    const text = typeof fact?.text === "string" ? fact.text : "";
    const reasoning = typeof fact?.reasoning === "string" ? fact.reasoning : "";
    if (reasoning.startsWith("merged:")) {
      merged.push(text, reasoning);
    } else if (reasoning.startsWith("abstract:")) {
      abstract.push(text, reasoning);
    } else {
      plain.push(text, reasoning);
    }
  }
  return { plain: plain.join("\n"), merged: merged.join("\n"), abstract: abstract.join("\n") };
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
  // QW2: operator-slice survival — pre anchors found in each fact partition.
  const OPERATOR_SLICES = ["plain", "merged", "abstract"];
  const sliceStats = new Map(OPERATOR_SLICES.map((s) => [s, { survived: 0, total: 0 }]));
  let chunksWithOperatorFacts = 0;
  // QW2: occurrence-level pre/post expression counts (the paper's density check).
  let preOccurrences = 0;
  let postOccurrences = 0;
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

    // QW2 (2026-11-24): pre/post expression counts (occurrence-level density).
    preOccurrences += countTemporalExpressions(pre).total;
    postOccurrences += countTemporalExpressions(post).total;

    // QW2 (2026-11-24): L2-facts → merged/abstracted-output survival. For each
    // partition of the persisted facts (plain vs merge/abstraction operator
    // output, identified by the reasoning marker), count how many of the pre
    // chunk's distinct anchors appear in that partition. A partition is
    // measured independently: "what fraction of the chunk's anchors does the
    // merged/abstract text still carry" — the gist-abstraction loss slice.
    const slices = partitionFactsByOperatorOutput(row.frontmatter);
    if (slices.merged.length > 0 || slices.abstract.length > 0) {
      chunksWithOperatorFacts += 1;
    }
    const anchorList = [...anchors.values()].flatMap((set) => [...set]);
    if (anchorList.length > 0) {
      for (const slice of OPERATOR_SLICES) {
        const s = sliceStats.get(slice);
        for (const anchor of anchorList) {
          s.total += 1;
          if (slices[slice].includes(anchor)) {
            s.survived += 1;
          }
        }
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

  // QW2 (2026-11-24): gist-abstraction slice. Survival of the pre chunk's
  // distinct anchors into each persisted fact partition — plain extracted
  // facts vs the textual-merge ("merged:") and LLM-abstraction ("abstract:")
  // operator outputs. This is the Sleeping Agent claim made addressable:
  // if anchors survive into plain facts but not into merged/abstract text,
  // abstraction is where temporal info dies.
  console.log("");
  console.log(
    `operator-slice survival (L2-facts → merged/abstracted outputs; chunks with operator facts: ${chunksWithOperatorFacts}):`,
  );
  console.log("slice         survived/total  survival");
  for (const slice of OPERATOR_SLICES) {
    const s = sliceStats.get(slice);
    console.log(
      `${slice.padEnd(13)} ${String(s.survived).padStart(4)}/${String(s.total).padEnd(6)}    ${pct(s.survived, s.total) ?? "n/a"}`,
    );
  }
  console.log(
    `ABSTRACTION: anchors carried by merged/abstract outputs vs plain facts — the fraction of the chunk's anchors each partition retains (low merged/abstract = temporal info dies at the abstraction operator)`,
  );

  // QW2 (2026-11-24): the paper's pre/post expression-count check —
  // occurrence-level density, complementing distinct-anchor survival.
  console.log("");
  console.log(
    `expression-count check (occurrences, not distinct anchors): pre=${preOccurrences}, post=${postOccurrences}, retention=${pct(postOccurrences, preOccurrences) ?? "n/a"} — post < pre = temporal density loss under compaction`,
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

// CLI guard: unit tests import the pure helpers above; only a direct
// `node temporal-survival-audit.mjs` invocation runs the audit itself.
const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
