#!/usr/bin/env node
// Shadow upstream-merge engine (Phase 2 — SHADOW MODE ONLY).
//
// Runs the REAL `git merge upstream/main` in a throwaway worktree with rerere and
// the merge=ours driver active, measures the RESIDUAL conflict surface (the files
// that still need judgment after auto-resolution), and reports. It is the autonomy
// readiness gauge: residual -> 0 means an autonomous merge could land.
//
// HARD SAFETY INVARIANTS (this build has no land path at all):
//   - operates ONLY inside a throwaway worktree it creates; refuses to touch the
//     live checkout,
//   - never commits to main, never pushes, never builds, never deploys.
//
// Usage: node scripts/upstream-merge-engine.mjs [--upstream <ref>] [--worktree <path>]
//                                               [--keep] [--pretty]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { areaOf, globToRegExp, parseMergeOursGlobs } from "./relocation-map.mjs";
import { parseMergeTree } from "./resync-ledger.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args, { cwd = repoRoot, allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 29 });
  } catch (err) {
    if (allowFail && err && typeof err === "object" && "stdout" in err) {
      return String(err.stdout ?? "");
    }
    throw err;
  }
}

// --- Pure helper (exported for tests) ---------------------------------------

// Count unmerged entries by their two-letter git status code (UU/AA/DU/UD/...).
export function parseUnmergedStatus(porcelain) {
  const counts = {};
  const files = [];
  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    const code = line.slice(0, 2);
    if (/^(DD|AU|UD|UA|DU|AA|UU)$/.test(code)) {
      counts[code] = (counts[code] ?? 0) + 1;
      files.push(line.slice(3));
    }
  }
  return { counts, files };
}

// --- Main -------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fb) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fb;
  };
  const upstream = flag("--upstream", "upstream/main");
  const worktree = resolve(repoRoot, "..", flag("--worktree", "openclaw-shadow-merge"));
  const keep = argv.includes("--keep");
  const pretty = argv.includes("--pretty");

  // Invariant: never operate on the live checkout.
  if (resolve(worktree) === resolve(repoRoot)) {
    throw new Error("refusing to run: worktree path must not be the live repo");
  }

  git(["fetch", "upstream", "-q"], { allowFail: true });
  const base = git(["merge-base", "HEAD", upstream]).trim();
  const behind = Number(git(["rev-list", "--count", `HEAD..${upstream}`]).trim());

  // Raw conflict surface with NO driver/rerere (read-only plumbing dry run).
  const { conflictedPaths: rawConflicts, conflictTypes } = parseMergeTree(
    git(["merge-tree", "--write-tree", "HEAD", upstream], { allowFail: true }),
  );

  // Fresh throwaway worktree off current main.
  if (existsSync(worktree)) {
    git(["worktree", "remove", "--force", worktree], { allowFail: true });
  }
  git(["worktree", "add", "--detach", worktree, "HEAD"]);

  let report;
  try {
    // The REAL merge — rerere replays known resolutions, merge=ours keeps owned files.
    git(["merge", "--no-commit", "--no-ff", upstream], { cwd: worktree, allowFail: true });

    const porcelain = git(["status", "--porcelain"], { cwd: worktree });
    const { counts, files: residualFiles } = parseUnmergedStatus(porcelain);
    const rerereRemaining = git(["rerere", "status"], { cwd: worktree, allowFail: true })
      .split("\n")
      .filter(Boolean);

    // merge=ours surface (same source as the other tools).
    const globs = parseMergeOursGlobs(readFileSync(resolve(repoRoot, ".gitattributes"), "utf8"));
    globs.push("extensions/codex/**");
    const protectors = globs.map((g) => globToRegExp(g));
    const isMergeOurs = (f) => protectors.some((re) => re.test(f));

    const residualByArea = {};
    let residualProtected = 0;
    for (const f of residualFiles) {
      residualByArea[areaOf(f)] = (residualByArea[areaOf(f)] ?? 0) + 1;
      if (isMergeOurs(f)) residualProtected += 1;
    }

    const rawCount = rawConflicts.size;
    const residualCount = residualFiles.length;

    report = {
      mode: "shadow",
      base,
      upstream,
      behind,
      rawConflicts: rawCount,
      conflictTypes,
      // What rerere + merge=ours + clean 3-way auto-resolved during the real merge.
      autoResolved: Math.max(0, rawCount - residualCount),
      residualConflicts: residualCount,
      residualByStatus: counts,
      residualByArea,
      residualStillProtected: residualProtected,
      rerereUnresolved: rerereRemaining.length,
      // Readiness: 0 residual => an autonomous merge could land without human judgment.
      autonomousMergeReady: residualCount === 0,
    };
  } finally {
    git(["merge", "--abort"], { cwd: worktree, allowFail: true });
    if (!keep) git(["worktree", "remove", "--force", worktree], { allowFail: true });
  }

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  if (pretty) {
    process.stderr.write(
      [
        "",
        "=== upstream-merge-engine (SHADOW — nothing landed) ===",
        `base=${base.slice(0, 12)} upstream=${upstream} behind=${behind}`,
        `raw conflicts (no driver): ${report.rawConflicts}`,
        `auto-resolved (rerere + merge=ours + clean): ${report.autoResolved}`,
        `RESIDUAL (needs judgment): ${report.residualConflicts}`,
        "  by status: " +
          Object.entries(report.residualByStatus)
            .map(([k, v]) => `${k}=${v}`)
            .join(" "),
        "  by area: " +
          Object.entries(report.residualByArea)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}`)
            .join(" "),
        `autonomous-merge-ready: ${report.autonomousMergeReady}`,
        "",
      ].join("\n") + "\n",
    );
  }
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  main();
}
