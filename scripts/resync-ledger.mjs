#!/usr/bin/env node
// Read-only resync ledger — the per-file merge planner for a full upstream sync.
//
// Runs a read-only `git merge-tree` dry run (writes NOTHING to the work tree or
// index) and classifies every merge-relevant file so a supervised resync is fully
// scoped before anyone touches `main`. Categories:
//   adopt      upstream changed, fork untouched            -> take upstream (free catch-up)
//   keep       fork changed, upstream untouched            -> keep fork as-is
//   auto       both changed, NO textual conflict           -> git 3-way auto-merges
//   keep-ours  conflict AND merge=ours-covered             -> driver keeps fork (silent-combo risk noted)
//   relocate   conflict AND part of a fork-relevant rename -> remap protection/edit to new path
//   resolve    conflict, unprotected, not a rename         -> the hard set (manual / LLM re-apply)
//
// Usage: node scripts/resync-ledger.mjs [--upstream <ref>] [--head <ref>] [--pretty] [--md <path>]
// Output: JSON on stdout; --pretty summary on stderr; --md writes a markdown ledger.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { areaOf, globToRegExp, parseMergeOursGlobs, parseRenameStatus } from "./relocation-map.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args, allowFail = false) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 29 });
  } catch (err) {
    // merge-tree exits 1 when conflicts exist; its stdout is still the payload.
    if (allowFail && err && typeof err === "object" && "stdout" in err) {
      return String(err.stdout ?? "");
    }
    throw err;
  }
}

// --- Pure helpers (exported for tests) --------------------------------------

// Parse `git merge-tree --write-tree <a> <b>` output. Shape: first line is the
// merged tree OID; then "Conflicted file info" lines (`<mode> <oid> <stage>\t<path>`)
// until a blank line; then informational "CONFLICT (<type>): ..." messages.
export function parseMergeTree(out) {
  const lines = out.split("\n");
  const conflictedPaths = new Set();
  const conflictTypes = {};
  let i = 0;
  // line 0 = tree oid (skip); info lines until first blank line
  for (i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") break;
    const tab = line.indexOf("\t");
    if (tab > 0) conflictedPaths.add(line.slice(tab + 1));
  }
  // remaining lines = informational messages
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^CONFLICT \(([^)]+)\)/);
    if (m) conflictTypes[m[1]] = (conflictTypes[m[1]] ?? 0) + 1;
  }
  return { conflictedPaths, conflictTypes };
}

// Deterministic per-file category. Inputs are booleans derived from git state.
export function categorizeFile({ forkChanged, upstreamChanged, conflicted, mergeOurs, relocated }) {
  if (!conflicted) {
    if (upstreamChanged && !forkChanged) return "adopt";
    if (forkChanged && !upstreamChanged) return "keep";
    return "auto"; // both changed but clean 3-way, or neither (defensive)
  }
  if (mergeOurs) return "keep-ours";
  if (relocated) return "relocate";
  return "resolve";
}

// Coarse file class from path — drives risk tiering of the resolve set.
export function fileClassOf(file) {
  if (/\.test\.[cm]?tsx?$/.test(file) || /(^|\/)tests?\//i.test(file) || /\/Tests\//.test(file)) {
    return "test";
  }
  if (file.startsWith("docs/") && file.endsWith(".md")) return "doc";
  if (file.endsWith(".swift")) return "swift";
  if (
    /(^|\/)(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|tsconfig[^/]*\.json|\.oxlintrc\.json|taxonomy\.yaml)$/.test(
      file,
    )
  ) {
    return "config";
  }
  return "source";
}

// Risk of resolving a conflict in this file. Tests/docs and isolated app/tooling
// dirs are low; config is bounded-medium; runtime source (agents/gateway/ui/pkgs)
// is high and resolved last.
export function riskTierOf(area, fileClass) {
  if (fileClass === "test" || fileClass === "doc") return "low";
  if (area === "apps/ios" || area === "scripts" || area === ".github") return "low";
  if (fileClass === "config") return "medium";
  if (area === "extensions") return "medium";
  if (area === "src" || area === "ui" || area === "packages") return "high";
  return "medium";
}

const TIER_ORDER = { low: 0, medium: 1, high: 2 };

// Group annotated resolve entries into ordered, single-tier batches: all low-risk
// warm-ups first, then medium, then high. Batches never cross a tier boundary so
// each can be fully proved before escalating; same-area files stay together.
export function planBatches(resolveEntries, batchSize = 30) {
  const byTier = { low: [], medium: [], high: [] };
  for (const e of resolveEntries) (byTier[e.riskTier] ?? byTier.medium).push(e);
  const batches = [];
  for (const tier of Object.keys(TIER_ORDER)) {
    const entries = byTier[tier].sort(
      (a, b) => a.area.localeCompare(b.area) || a.file.localeCompare(b.file),
    );
    for (let i = 0; i < entries.length; i += batchSize) {
      const slice = entries.slice(i, i + batchSize);
      batches.push({
        n: batches.length + 1,
        tier,
        areas: [...new Set(slice.map((e) => e.area))],
        files: slice.map((e) => e.file),
      });
    }
  }
  return batches;
}

// --- Main (skipped when imported) -------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fb) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fb;
  };
  const upstream = flag("--upstream", "upstream/main");
  const head = flag("--head", "HEAD");
  const pretty = argv.includes("--pretty");
  const mdPath = flag("--md", null);

  const base = git(["merge-base", head, upstream]).trim();

  // Protection surface (same source as relocation-map / divergence report).
  const globs = parseMergeOursGlobs(readFileSync(resolve(repoRoot, ".gitattributes"), "utf8"));
  globs.push("extensions/codex/**");
  const protectors = globs.map((g) => globToRegExp(g));
  const isMergeOurs = (f) => protectors.some((re) => re.test(f));

  const forkChanged = new Set(git(["diff", "--name-only", base, head]).split("\n").filter(Boolean));
  const upstreamChanged = new Set(
    git(["diff", "--name-only", base, upstream]).split("\n").filter(Boolean),
  );

  // Fork-relevant rename set (old + new paths) from the relocation view.
  const renames = parseRenameStatus(
    git(["diff", "-M40%", "--find-renames", "--name-status", base, upstream]),
  );
  const relocatedPaths = new Set();
  for (const r of renames) {
    if (forkChanged.has(r.oldPath) || isMergeOurs(r.oldPath)) {
      relocatedPaths.add(r.oldPath);
      relocatedPaths.add(r.newPath);
    }
  }

  // Read-only dry-run merge.
  const { conflictedPaths, conflictTypes } = parseMergeTree(
    git(["merge-tree", "--write-tree", head, upstream], true),
  );

  const allFiles = new Set([...forkChanged, ...upstreamChanged, ...conflictedPaths]);
  const ledger = [];
  for (const file of allFiles) {
    const category = categorizeFile({
      forkChanged: forkChanged.has(file),
      upstreamChanged: upstreamChanged.has(file),
      conflicted: conflictedPaths.has(file),
      mergeOurs: isMergeOurs(file),
      relocated: relocatedPaths.has(file),
    });
    // Only the merge-relevant files matter; skip pure-noise "auto" with neither side.
    if (category === "auto" && !forkChanged.has(file) && !upstreamChanged.has(file)) continue;
    ledger.push({ file, category, area: areaOf(file) });
  }

  const byCategory = {};
  const resolveByArea = {};
  for (const e of ledger) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    if (e.category === "resolve") resolveByArea[e.area] = (resolveByArea[e.area] ?? 0) + 1;
  }

  // Annotate the hard set with file class + risk tier, then plan warm-up-first batches.
  const resolveEntries = ledger
    .filter((e) => e.category === "resolve")
    .map((e) => {
      const fileClass = fileClassOf(e.file);
      return { ...e, fileClass, riskTier: riskTierOf(e.area, fileClass) };
    })
    .sort((a, b) => a.area.localeCompare(b.area) || a.file.localeCompare(b.file));
  const resolveByTier = {};
  for (const e of resolveEntries) resolveByTier[e.riskTier] = (resolveByTier[e.riskTier] ?? 0) + 1;
  const batches = planBatches(resolveEntries);

  const report = {
    base,
    head,
    upstream,
    totals: {
      files: ledger.length,
      forkChanged: forkChanged.size,
      upstreamChanged: upstreamChanged.size,
      conflicted: conflictedPaths.size,
    },
    byCategory,
    conflictTypes,
    resolveByArea,
    resolveByTier,
    batches: batches.map((b) => ({ n: b.n, tier: b.tier, areas: b.areas, count: b.files.length })),
    resolve: resolveEntries,
    ledger,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  if (mdPath) {
    const md = [
      `# Resync ledger — ${base.slice(0, 12)}..${upstream}`,
      "",
      `- files: ${report.totals.files} · conflicted: ${report.totals.conflicted}`,
      `- categories: ${Object.entries(byCategory)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
      `- conflict types: ${Object.entries(conflictTypes)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
      "",
      `- resolve by tier: ${Object.entries(resolveByTier)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
      "",
      "## batch plan (low-risk warm-ups first)",
      ...batches.map(
        (b) => `- batch ${b.n} [${b.tier}] ${b.areas.join(", ")} — ${b.files.length} files`,
      ),
      "",
      "## resolve (needs judgment)",
      ...report.resolve.map((e) => `- [${e.riskTier}/${e.area}] ${e.file}`),
      "",
    ].join("\n");
    writeFileSync(resolve(repoRoot, mdPath), md);
  }

  if (pretty) {
    process.stderr.write(
      [
        "",
        "=== resync ledger ===",
        `base=${base.slice(0, 12)} upstream=${upstream}`,
        `files=${report.totals.files} conflicted=${report.totals.conflicted}`,
        "categories: " +
          Object.entries(byCategory)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}`)
            .join(" "),
        "conflict types: " +
          Object.entries(conflictTypes)
            .map(([k, v]) => `${k}=${v}`)
            .join(" "),
        "resolve-set by area: " +
          Object.entries(resolveByArea)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}`)
            .join(" "),
        "resolve-set by tier: " +
          Object.entries(resolveByTier)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ") +
          `  (${batches.length} batches)`,
        "",
      ].join("\n") + "\n",
    );
  }
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  main();
}
