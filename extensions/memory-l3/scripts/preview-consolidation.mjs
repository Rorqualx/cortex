#!/usr/bin/env node
// Preview what consolidation would promote against the live workspace.
// Pure JS, no build dependency — same approach as check-retrieval.mjs.
// Usage: node extensions/memory-l3/scripts/preview-consolidation.mjs

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WORKSPACE_DIR = path.join(os.homedir(), ".openclaw", "workspace");
const L2_DIR = path.join(WORKSPACE_DIR, ".openclaw", "l3", "l2");
const LONG_TERM_FILE = path.join(WORKSPACE_DIR, ".openclaw", "l3", "longterm.md");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const CONFIG = {
  minRecallCount: 2,
  minDayspanMs: 3 * MS_PER_DAY,
  minImportance: 0.6,
  highImportancePassthrough: 0.85,
};

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

function aggregate() {
  const candidates = new Map();
  for (const file of listL2Chunks()) {
    const fm = readFrontmatter(file);
    if (!fm) {
      continue;
    }
    const chunkId = fm.id;
    for (const fact of fm.facts ?? []) {
      const existing = candidates.get(fact.dedupKey);
      if (!existing) {
        candidates.set(fact.dedupKey, {
          dedupKey: fact.dedupKey,
          text: fact.text,
          importance: fact.importance,
          recallCount: 1,
          firstSeenAt: fact.createdAt,
          lastConfirmedAt: fact.createdAt,
          sourceChunkIds: [chunkId],
        });
      } else {
        const prevLast = existing.lastConfirmedAt;
        existing.recallCount += 1;
        existing.firstSeenAt = Math.min(existing.firstSeenAt, fact.createdAt);
        existing.lastConfirmedAt = Math.max(existing.lastConfirmedAt, fact.createdAt);
        if (
          fact.importance > existing.importance ||
          (fact.importance === existing.importance && fact.createdAt > prevLast)
        ) {
          existing.text = fact.text;
          existing.importance = fact.importance;
        }
        if (!existing.sourceChunkIds.includes(chunkId)) {
          existing.sourceChunkIds.push(chunkId);
        }
      }
    }
  }
  return [...candidates.values()];
}

function passes(c) {
  if (c.importance >= CONFIG.highImportancePassthrough) {
    return { pass: true, reason: "high-importance shortcut" };
  }
  const dayspan = c.lastConfirmedAt - c.firstSeenAt;
  if (c.recallCount < CONFIG.minRecallCount) {
    return { pass: false, reason: `recall=${c.recallCount} < ${CONFIG.minRecallCount}` };
  }
  if (dayspan < CONFIG.minDayspanMs) {
    return { pass: false, reason: `dayspan=${(dayspan / MS_PER_DAY).toFixed(1)}d < 3d` };
  }
  if (c.importance < CONFIG.minImportance) {
    return {
      pass: false,
      reason: `importance=${c.importance.toFixed(2)} < ${CONFIG.minImportance}`,
    };
  }
  return { pass: true, reason: "recall+dayspan+importance" };
}

const chunks = listL2Chunks();
const candidates = aggregate();
const ltExists = existsSync(LONG_TERM_FILE);

console.log(`Workspace:    ${WORKSPACE_DIR}`);
console.log(`L2 chunks:    ${chunks.length}`);
console.log(`Candidates:   ${candidates.length} distinct dedupKeys`);
console.log(`longterm.md:  ${ltExists ? "exists" : "(absent)"}`);
console.log("");

const accepted = [];
const rejected = [];
for (const c of candidates) {
  const verdict = passes(c);
  if (verdict.pass) {
    accepted.push({ c, reason: verdict.reason });
  } else {
    rejected.push({ c, reason: verdict.reason });
  }
}

console.log(`Would promote (${accepted.length}):`);
for (const { c, reason } of accepted.toSorted((a, b) => b.c.importance - a.c.importance)) {
  console.log(`  ★ [${c.importance.toFixed(2)}] ${c.dedupKey}`);
  console.log(
    `    via: ${reason}; recall=${c.recallCount}, dayspan=${((c.lastConfirmedAt - c.firstSeenAt) / MS_PER_DAY).toFixed(1)}d`,
  );
  console.log(`    text: ${c.text.slice(0, 100)}`);
}
console.log("");
console.log(`Would NOT promote (${rejected.length}):`);
for (const { c, reason } of rejected
  .toSorted((a, b) => b.c.importance - a.c.importance)
  .slice(0, 10)) {
  console.log(`  · [${c.importance.toFixed(2)}] ${c.dedupKey} — ${reason}`);
}
if (rejected.length > 10) {
  console.log(`  ... and ${rejected.length - 10} more.`);
}
