#!/usr/bin/env node
// Deletion-verification audit (QW7, 2026-11-25 — FORGETMENOT,
// arXiv watch-list finding: post-deletion memory leakage in all 5 audited
// commercial agents).
//
// Read-only diagnostic: after a memory deletion (fact, slot, dedup key, or
// any text), verify ZERO residual rows across every surface that could still
// carry a trace of it:
//   - l3.sqlite: l3_kv (longterm keys/values), l3_l2_chunks (frontmatter+body),
//     l3_epochs (frontmatter+body), l3_message_chunks (raw text),
//     l3_entities (data), l3_topic_links (data), l3_retrieval_signals
//     (fact_id+data), l3_edges (data), l3_hype_queries (fact_id+query_text)
//   - retrieval-use.sqlite: retrieval_use_daily / retrieval_use_sessions /
//     session_outcomes — both directly (chunk/session ids containing the
//     needle) and second-order (chunk ids of L2 rows that still contain the
//     needle but live on in the use telemetry)
//   - CCR store (compression-cache.db): ccr_cache.content
//   - regenerated markdown mirrors + file artifacts under the l3 root:
//     l2/*.md, l3/*.md, longterm*.md, l1_archive/*.jsonl, memory/.l3/*.md
//
// FORGETMENOT found leakage in every audited commercial agent — our privacy
// red lines deserve the same check. Pairs with the temporal-survival-audit
// script (same read-only harness discipline, two different checks).
//
// Usage:
//   node extensions/memory-l3/scripts/deletion-verification-audit.mjs \
//     --needle="<fact id / slot / dedup key / text>" \
//     [--root=<l3 dir>] [--ccr=<ccr sqlite path>] [--verbose]
//
// Root resolution: --root → <cwd>/.openclaw/l3 → ~/.openclaw/workspace/.openclaw/l3.
// CCR resolution: --ccr → <root>/../compression-cache.db (agentDir sibling),
// if present.
// Matching is case-insensitive substring; all scans are plain LIKE/includes
// over full rows — linear time, no regexes, no backtracking risk.
// Output: per-surface residual table + verdict. Exit code: 0 = clean,
// 1 = residuals found, 2 = usage error. NEVER writes to any store; safe to
// run against a live gateway.

import { readFile, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

function usage() {
  console.error(
    "usage: node deletion-verification-audit.mjs --needle=<text> [--root=<l3 dir>] [--ccr=<db>] [--verbose]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = new Map();
  for (const raw of argv.slice(2)) {
    const m = /^--([a-z-]+)=(.*)$/i.exec(raw);
    if (m && m[1] && m[2] !== undefined) {
      args.set(m[1].toLowerCase(), m[2]);
    }
  }
  return args;
}

async function resolveRoot(explicit) {
  if (explicit) {
    return explicit;
  }
  const cwdDefault = path.join(process.cwd(), ".openclaw", "l3");
  try {
    await readdir(cwdDefault);
    return cwdDefault;
  } catch {
    return path.join(os.homedir(), ".openclaw", "workspace", ".openclaw", "l3");
  }
}

/** Open a sqlite db; missing/unreadable file → null (surface absent). */
function openDb(file) {
  try {
    return new DatabaseSync(file);
  } catch {
    return null;
  }
}

/** Count rows in `table` where any of `columns` contains the needle (case-insensitive). */
function countSqliteResiduals(db, table, columns, needle, verbose) {
  try {
    const where = columns.map((c) => `lower(${c}) LIKE ?`).join(" OR ");
    // Bind the needle once per placeholder — a single param leaves the
    // remaining placeholders NULL-bound, silently narrowing the scan to the
    // first column (caught by the smoke run).
    const params = columns.map(() => `%${needle.toLowerCase()}%`);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).all(...params);
    const n = rows[0] ? Number(rows[0].n) : 0;
    if (verbose && n > 0) {
      const sample = db.prepare(`SELECT * FROM ${table} WHERE ${where} LIMIT 3`).all(...params);
      for (const row of sample) {
        const shown = JSON.stringify(row).slice(0, 160);
        console.error(`    [${table}] ${shown}`);
      }
    }
    return n;
  } catch {
    // Table missing in this schema version — not a residual surface.
    return 0;
  }
}

/** Collect ids of L2/message rows still containing the needle (second-order telemetry join). */
function residualChunkIds(db, needle) {
  const ids = new Set();
  const like = `%${needle.toLowerCase()}%`;
  try {
    const rows = db
      .prepare(
        "SELECT id, frontmatter, body FROM l3_l2_chunks WHERE lower(frontmatter) LIKE ? OR lower(body) LIKE ?",
      )
      .all(like, like);
    for (const r of rows) {
      ids.add(r.id);
    }
  } catch {
    // ignore
  }
  try {
    const rows = db
      .prepare("SELECT chunk_id, text FROM l3_message_chunks WHERE lower(text) LIKE ?")
      .all(like);
    for (const r of rows) {
      ids.add(r.chunk_id);
    }
  } catch {
    // ignore
  }
  return ids;
}

async function scanFiles(root, needle, verbose) {
  const relDirs = ["l2", "l3", "l1_archive"];
  const relFiles = ["longterm.md", "longterm-typed.md"];
  const targets = [];
  for (const d of relDirs) {
    try {
      for (const f of await readdir(path.join(root, d))) {
        targets.push(path.join(root, d, f));
      }
    } catch {
      // dir absent — skip
    }
  }
  for (const f of relFiles) {
    targets.push(path.join(root, f));
  }
  // memory/.l3/ markdown mirror (sibling of the .openclaw/l3 root).
  const mirror = path.resolve(root, "..", "..", "memory", ".l3");
  try {
    for (const f of await readdir(mirror)) {
      if (f.endsWith(".md") || f.endsWith(".json")) {
        targets.push(path.join(mirror, f));
      }
    }
  } catch {
    // mirror absent — skip
  }

  const lower = needle.toLowerCase();
  let files = 0;
  let residuals = 0;
  const filesWithResiduals = [];
  for (const t of targets) {
    try {
      const text = (await readFile(t, "utf8")).toLowerCase();
      files += 1;
      if (text.includes(lower)) {
        residuals += 1;
        filesWithResiduals.push(path.relative(root, t) || t);
      }
    } catch {
      // unreadable file — skip
    }
  }
  if (verbose) {
    for (const f of filesWithResiduals.slice(0, 5)) {
      console.error(`    [file] ${f}`);
    }
  }
  return { files, residuals, filesWithResiduals };
}

async function main() {
  const args = parseArgs(process.argv);
  const needle = args.get("needle");
  if (!needle || needle.length === 0) {
    usage();
  }
  const root = await resolveRoot(args.get("root"));
  const verbose = args.has("verbose") || process.argv.includes("--verbose");

  console.error(`deletion-verification-audit (QW7, 2026-11-25)`);
  console.error(`  root: ${root}`);
  console.error(`  needle: ${needle.slice(0, 80)}${needle.length > 80 ? "…" : ""}`);
  console.error(`  mode: READ-ONLY (no store is modified)`);

  let total = 0;
  const lines = [];

  // --- l3.sqlite surfaces ---
  const l3Path = path.join(root, "l3.sqlite");
  const l3 = openDb(l3Path);
  if (l3) {
    const surfaces = [
      ["l3_kv", ["key", "value"]],
      ["l3_l2_chunks", ["frontmatter", "body"]],
      ["l3_epochs", ["frontmatter", "body"]],
      ["l3_message_chunks", ["text"]],
      ["l3_entities", ["id", "data"]],
      ["l3_topic_links", ["source_chunk_id", "target_chunk_id", "data"]],
      ["l3_retrieval_signals", ["fact_id", "data"]],
      ["l3_edges", ["data"]],
      ["l3_hype_queries", ["fact_id", "query_text"]],
    ];
    for (const [table, cols] of surfaces) {
      const n = countSqliteResiduals(l3, table, cols, needle, verbose);
      lines.push(`  l3.sqlite:${table.padEnd(22)} ${n}`);
      total += n;
    }

    // --- retrieval-use.sqlite ---
    const usePath = path.join(root, "retrieval-use.sqlite");
    const use = openDb(usePath);
    if (use) {
      const useTables = [
        ["retrieval_use_daily", ["chunk_id"]],
        ["retrieval_use_sessions", ["chunk_id", "session_id"]],
        ["session_outcomes", ["session_id"]],
      ];
      for (const [table, cols] of useTables) {
        const n = countSqliteResiduals(use, table, cols, needle, verbose);
        lines.push(`  retrieval-use.sqlite:${table.padEnd(14)} ${n}`);
        total += n;
      }
      // Second-order: chunks whose L2 rows still carry the needle but whose
      // telemetry lives on in the use store.
      const ids = residualChunkIds(l3, needle);
      if (ids.size > 0) {
        const like = [...ids];
        let n = 0;
        // Each table in its own try: a pre-QW2 store without the session
        // table must not kill the daily count (caught by the smoke run).
        const placeholders = like.map(() => "?").join(", ");
        try {
          const daily = use
            .prepare(
              `SELECT COUNT(*) AS n FROM retrieval_use_daily WHERE chunk_id IN (${placeholders})`,
            )
            .all(...like);
          n += Number(daily[0]?.n ?? 0);
        } catch {
          // table absent — skip
        }
        try {
          const sessions = use
            .prepare(
              `SELECT COUNT(*) AS n FROM retrieval_use_sessions WHERE chunk_id IN (${placeholders})`,
            )
            .all(...like);
          n += Number(sessions[0]?.n ?? 0);
        } catch {
          // pre-QW2 schema without the session table
        }
        lines.push(`  retrieval-use.sqlite:telemetry-of-residual-chunks ${n}`);
        total += n;
      }
    } else {
      lines.push(`  retrieval-use.sqlite: (absent — skipped)`);
    }

    l3.close();
  } else {
    lines.push(`  l3.sqlite: (absent — skipped)`);
  }

  // --- CCR store ---
  const ccrPath = args.get("ccr") ?? path.join(root, "..", "compression-cache.db");
  const ccr = openDb(ccrPath);
  if (ccr) {
    const n = countSqliteResiduals(ccr, "ccr_cache", ["content", "content_type"], needle, verbose);
    lines.push(`  ccr:${"compression-cache.db".padEnd(26)} ${n}`);
    total += n;
    ccr.close();
  } else {
    lines.push(`  ccr: (no compression-cache.db at ${ccrPath} — skipped)`);
  }

  // --- markdown mirrors + file artifacts ---
  const fileScan = await scanFiles(root, needle, verbose);
  lines.push(`  files:${`${fileScan.files} scanned`.padEnd(23)} ${fileScan.residuals}`);
  total += fileScan.residuals;

  for (const line of lines) {
    console.error(line);
  }
  console.error("");
  if (total === 0) {
    console.error(`VERDICT: CLEAN — zero residual traces of the needle across all surfaces.`);
    process.exit(0);
  }
  console.error(`VERDICT: ${total} RESIDUAL TRACE(S) — deletion did not fully propagate.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`deletion-verification-audit failed: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
