#!/usr/bin/env node
// Deterministic upstream-divergence classifier for the autonomous nightly cron.
//
// Splits `<base>..<upstream>` commits into CHERRY-CANDIDATE (safe standalone
// cherry-picks) vs DEFER (needs a maintainer $openclaw-upstream-resync pass).
// The convergent-surface definition is REUSED from `.gitattributes merge=ours`
// (the canonical fork-protection list) plus `extensions/codex/**` (codex hard
// gate) — never re-hardcoded here, so widening protection widens the gate.
//
// Read-only: runs only `git` plumbing, mutates nothing. Emits JSON on stdout
// (add --pretty for a human summary on stderr).
//
// Usage: node scripts/upstream-divergence-report.mjs [--base <ref>] [--upstream <ref>] [--pretty]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const base = flag("--base", "main");
const upstream = flag("--upstream", "upstream/main");
const pretty = argv.includes("--pretty");

// --- Convergent surface: parse `.gitattributes` merge=ours globs -------------
// Line shape: `<glob><whitespace>merge=ours`. Comments (`#`) are skipped.
function parseMergeOursGlobs() {
  const text = readFileSync(resolve(repoRoot, ".gitattributes"), "utf8");
  const globs = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !/\bmerge=ours\b/.test(line)) continue;
    const glob = line.split(/\s+/)[0];
    if (glob) globs.push(glob);
  }
  // Codex is folded into openai and deliberately trimmed; never auto-touch it.
  globs.push("extensions/codex/**");
  return globs;
}

// Minimal glob→regex: `**` = any (incl. `/`), `*` = non-slash run, `?` = one char.
// A glob ending in `/` is treated as a directory prefix.
function globToRegExp(glob) {
  let g = glob;
  let prefixDir = false;
  if (g.endsWith("/")) {
    prefixDir = true;
    g = g.slice(0, -1);
  }
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + (prefixDir ? "(/.*)?$" : "$"));
}

const convergentGlobs = parseMergeOursGlobs();
const convergentRes = convergentGlobs.map((g) => ({ glob: g, re: globToRegExp(g) }));

function matchedConvergent(file) {
  for (const { glob, re } of convergentRes) if (re.test(file)) return glob;
  return null;
}

// Adjacent zones: dirs that also *contain* convergent-surface files. A fix that
// only touches these (but no exact protected file) is a cherry-candidate but
// flagged `borderline` for a claude-connect second opinion.
const ADJACENT_ZONES = [
  "src/agents/",
  "packages/agent-core/",
  "src/gateway/",
  "src/config/",
  "src/cron/",
  "extensions/memory-core/",
  "ui/src/ui/chat/",
];
const BORDERLINE_FILE_COUNT = 15;

// Types eligible for autonomous cherry-pick (low-entanglement bug/perf/security).
const CHERRY_TYPES = new Set(["fix", "perf", "security", "revert-fix"]);

// --- Enumerate commits (chronological, oldest-first) -------------------------
// Single-pass `git log`: one process for the whole range. The previous shape
// spawned two `git show` per commit and OOM/timed out beyond ~5k commits, which
// blocked the nightly entirely at real divergence scale.
const range = `${base}..${upstream}`;
const mergeShas = new Set(git(["rev-list", "--merges", range]).split("\n").filter(Boolean));
const logRaw = git(["log", "--reverse", "--name-only", `--format=%x00%H%x1f%s`, range]);
const commits = [];
for (const block of logRaw.split("\u0000")) {
  const sep = block.indexOf("\u001f");
  if (sep < 0) continue;
  const sha = block.slice(0, sep).trim();
  const lines = block.slice(sep + 1).split("\n");
  const subject = (lines[0] ?? "").trim();
  const files = lines.slice(1).map((l) => l.trim()).filter(Boolean);
  if (sha) commits.push({ sha, subject, files });
}

const mix = {};
const cherryCandidates = [];
const deferred = [];
const forkExclusiveTouched = new Set();
const hotspotsTouched = new Set();

for (const { sha, subject, files } of commits) {
  const typeMatch = subject.match(/^([a-z]+)/);
  const type = typeMatch ? typeMatch[1] : "other";
  mix[type] = (mix[type] || 0) + 1;

  const isSecurity = /\bsecurity\b|\bCVE-|\bvuln/i.test(subject);

  // Which convergent-surface globs does this commit touch?
  const hits = [];
  for (const f of files) {
    const g = matchedConvergent(f);
    if (g) {
      hits.push({ file: f, glob: g });
      if (
        g.startsWith("extensions/") ||
        g.startsWith("src/skill-forge") ||
        g.includes("memory-l3")
      ) {
        forkExclusiveTouched.add(g);
      } else {
        hotspotsTouched.add(g);
      }
    }
  }

  // --- Decision (defer wins on any doubt) ---
  if (mergeShas.has(sha)) {
    deferred.push({ sha: sha.slice(0, 12), subject, reason: "merge commit" });
    continue;
  }
  if (files.length === 0) {
    deferred.push({ sha: sha.slice(0, 12), subject, reason: "empty / no files" });
    continue;
  }
  if (hits.length > 0) {
    const codex = hits.find((h) => h.glob.startsWith("extensions/codex"));
    deferred.push({
      sha: sha.slice(0, 12),
      subject,
      reason: codex
        ? "touches codex (hard gate)"
        : `touches protected surface: ${[...new Set(hits.map((h) => h.glob))].slice(0, 3).join(", ")}`,
    });
    continue;
  }
  if (!CHERRY_TYPES.has(type) && !isSecurity) {
    deferred.push({
      sha: sha.slice(0, 12),
      subject,
      reason: `type=${type} (not fix/perf/security)`,
    });
    continue;
  }

  // Cherry-eligible. Flag borderline for a claude-connect second opinion.
  const adjacent = files.some((f) => ADJACENT_ZONES.some((z) => f.startsWith(z)));
  const borderline = adjacent || files.length > BORDERLINE_FILE_COUNT;
  cherryCandidates.push({
    sha: sha.slice(0, 12),
    subject,
    type: isSecurity ? "security" : type,
    fileCount: files.length,
    files: files.slice(0, 40),
    borderline,
    borderlineReason: borderline
      ? adjacent
        ? "touches fork-adjacent zone"
        : `large diff (${files.length} files)`
      : undefined,
  });
}

// --- Unlanded-resync detection ----------------------------------------------
// A local resync/redo branch whose upstream merge-base is NEWER than main's
// means a finished (or in-flight) resync exists that main does not have. Every
// divergence number this report emits is then measured from the WRONG baseline
// (this exact failure produced 13 days of misleading NO LAND reports in July
// 2026). Surface it loudly instead of letting the nightly re-classify from main.
const mainUpstreamBase = git(["merge-base", base, upstream]).trim();
const unlandedResyncBranches = [];
for (const branch of git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
  .split("\n")
  .filter((b) => /resync|redo/i.test(b))) {
  try {
    const branchBase = git(["merge-base", branch, upstream]).trim();
    if (branchBase === mainUpstreamBase) continue;
    // Throws (non-zero exit) when main's base is NOT an ancestor — caught below.
    git(["merge-base", "--is-ancestor", mainUpstreamBase, branchBase]);
    unlandedResyncBranches.push({
      branch,
      upstreamBase: branchBase.slice(0, 12),
      aheadOfMainBase: Number(
        git(["rev-list", "--count", `${mainUpstreamBase}..${branchBase}`]).trim(),
      ),
    });
  } catch {
    // is-ancestor exits non-zero when not an ancestor — not an unlanded resync.
  }
}

const report = {
  base,
  upstream,
  n: commits.length,
  merges: mergeShas.size,
  unlandedResyncBranches,
  mix,
  forkExclusiveTouched: [...forkExclusiveTouched].sort(),
  hotspotsTouched: [...hotspotsTouched].sort(),
  cherryCandidates,
  deferred,
  counts: {
    cherry: cherryCandidates.length,
    cherryBorderline: cherryCandidates.filter((c) => c.borderline).length,
    deferred: deferred.length,
  },
};

process.stdout.write(JSON.stringify(report, null, 2) + "\n");

if (pretty) {
  const mixStr = Object.entries(mix)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(" · ");
  if (unlandedResyncBranches.length > 0) {
    for (const u of unlandedResyncBranches) {
      process.stderr.write(
        `\n⚠️  UNLANDED RESYNC: branch ${u.branch} contains a newer upstream base ` +
          `(${u.upstreamBase}, +${u.aheadOfMainBase} upstream commits past main's base). ` +
          `Land or reconcile it FIRST — divergence below is measured from main and is misleading.\n`,
      );
    }
  }
  process.stderr.write(
    `\nN=${report.n} (${report.merges} merges) — ${mixStr}\n` +
      `cherry: ${report.counts.cherry} (${report.counts.cherryBorderline} borderline) · deferred: ${report.counts.deferred}\n` +
      `hotspots touched: ${report.hotspotsTouched.length} · fork-exclusive touched: ${report.forkExclusiveTouched.length}\n`,
  );
}
