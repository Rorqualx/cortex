#!/usr/bin/env node
// scripts/fork-merge-guard.mjs
// Pre-merge dry-run guard for the fork. Validates that an upstream merge won't
// silently break fork configs, protected files, or fork-exclusive code.
//
// Usage:
//   node scripts/fork-merge-guard.mjs upstream/main           # Dry-run merge
//   node scripts/fork-merge-guard.mjs upstream/main --apply   # Apply after passing
//
// What it checks:
//   1. Working tree is clean (no uncommitted changes)
//   2. Baseline exists and is current (runs fork-config-snapshot verify)
//   3. Dry-run merge (--no-commit) succeeds
//   4. No literal conflict markers remain
//   5. No protected files were modified by the merge
//   6. Fork-exclusive directories still exist
//   7. merge=ours entries in .gitattributes unchanged
//   8. TypeScript compiles cleanly (optional, --skip-tsc to skip)
//   9. Post-merge baseline drift check
//
// Exits 0 = safe to merge, 1 = problems found.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const PROTECTED_FILES = [
  // memory-l3 extension
  "extensions/memory-l3/",
  // memory-core prompts
  "extensions/memory-core/src/prompt-section.ts",
  "extensions/memory-core/src/tools.citations.ts",
  // skill-forge
  "src/skill-forge/",
  // doom loop guard
  "src/agents/doom-loop-guard.ts",
  "src/agents/tool-loop-detection-config.ts",
  // SSE transport default
  "src/agents/embedded-agent-runner/extra-params.ts",
  // thinking stream to UI
  "packages/gateway-protocol/src/schema/logs-chat.ts",
  "src/gateway/server-chat.ts",
  "src/gateway/server-chat-state.ts",
  "ui/src/ui/chat/run-lifecycle.ts",
  "ui/src/ui/app.ts",
  "ui/src/ui/app-render.ts",
  "ui/src/ui/types/chat-types.ts",
  "ui/src/ui/chat/build-chat-items.ts",
  "ui/src/ui/views/chat.ts",
  "ui/src/ui/chat/grouped-render.ts",
  "ui/src/styles/chat/grouped.css",
  "ui/src/ui/controllers/chat.ts",
  "ui/src/ui/app-view-state.ts",
  // packageVersion plumbing
  "src/plugins/channel-catalog-registry.ts",
];

// ── Helpers ──────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return {
      ok: true,
      stdout: execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }).trim(),
    };
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout?.trim() || "",
      stderr: e.stderr?.trim() || "",
      code: e.status,
    };
  }
}

let failures = 0;
let warnings = 0;

function pass(msg) {
  console.log(c.green(`  ✓ ${msg}`));
}
function fail(msg) {
  failures++;
  console.log(c.red(`  ✗ ${msg}`));
}
function warn(msg) {
  warnings++;
  console.log(c.yellow(`  ⚠ ${msg}`));
}
function section(msg) {
  console.log(`\n${c.bold(`── ${msg} ──`)}`);
}

// ── Parse args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const doApply = args.includes("--apply");
const skipTsc = args.includes("--skip-tsc");
const branch = args.find((a) => !a.startsWith("--"));

if (!branch) {
  console.error("Usage: fork-merge-guard.mjs <branch> [--apply] [--skip-tsc]");
  process.exit(1);
}

// ── 1. Working tree check ────────────────────────────────────────────────

section("Working tree");
const status = run("git status --porcelain");
if (!status.ok) {
  fail("git status failed");
  process.exit(1);
}
if (status.stdout) {
  fail(`Working tree dirty — ${status.stdout.split("\n").length} files`);
} else {
  pass("Clean working tree");
}

if (failures) {
  console.log(c.red("\nAborting: commit or stash changes first."));
  process.exit(1);
}

// ── 2. Baseline check ────────────────────────────────────────────────────

section("Config baseline");
const baseChk = run("node scripts/fork-config-snapshot.mjs verify");
if (baseChk.code === 1) {
  warn("Baseline drift detected. Consider regenerating after merge.");
  warn("Run: node scripts/fork-config-snapshot.mjs generate");
} else {
  pass("Baseline matches current state");
}

// ── 3. Dry-run merge ─────────────────────────────────────────────────────

section(`Dry-run merge: ${branch}`);
const mergeBase = run("git merge-base HEAD " + branch);
if (!mergeBase.ok) {
  fail("Cannot find merge base");
  process.exit(1);
}
const baseSha = mergeBase.stdout;
console.log(c.dim(`  Merge base: ${baseSha.slice(0, 12)}`));

const dryRun = run(`git merge --no-commit --no-ff ${branch}`);
if (!dryRun.ok) {
  if (dryRun.stderr?.includes("CONFLICT")) {
    fail("Merge conflicts detected:");
    const conflicts = dryRun.stdout.split("\n").filter((l) => l.includes("CONFLICT"));
    for (const l of conflicts) {
      console.log(c.red(`    ${l}`));
    }
  } else {
    fail(`Merge failed: ${dryRun.stderr || dryRun.stdout}`);
  }
  // Abort the merge attempt
  run("git merge --abort");
  process.exit(1);
} else {
  pass("Merge applies cleanly (no conflicts)");
}

// ── 4. Conflict marker scan ──────────────────────────────────────────────

section("Conflict marker scan");
const markers = run('git diff --cached -S "<<<<<<< "');
if (markers.ok && markers.stdout) {
  fail("Conflict markers found in staged files");
  console.log(markers.stdout.split("\n").slice(0, 10).join("\n"));
} else {
  pass("No conflict markers in staged files");
}

// Also scan for <<<<<<< in all tracked files (not just staged)
const allMarkers = run(
  'grep -r "<<<<<<< " --include="*.ts" --include="*.js" --include="*.mjs" --include="*.json" --include="*.yaml" --include="*.yml" -l . 2>/dev/null || true',
);
if (allMarkers.stdout) {
  const legitPatterns = [
    /node_modules\//,
    /\.test\./,
    /check-no-conflict-markers/,
    /fork-merge-guard\.mjs/,
    /fork-merge-verify\.mjs/,
    /\.snap$/,
  ];
  const hits = allMarkers.stdout
    .split("\n")
    .filter(Boolean)
    .filter((f) => !legitPatterns.some((p) => p.test(f)));
  if (hits.length) {
    fail("Conflict markers found in working tree:");
    for (const f of hits.slice(0, 10)) {
      console.log(c.red(`    ${f}`));
    }
  } else {
    pass("No conflict markers in tree (excluding fixtures)");
  }
} else {
  pass("No conflict markers anywhere in tree");
}

// ── 5. Protected files check ─────────────────────────────────────────────

section("Protected files");
const diffOut = run(`git diff --cached --name-only ${baseSha}`);
const changedFiles = diffOut.ok ? diffOut.stdout.split("\n").filter(Boolean) : [];

let protectedHits = 0;
for (const proto of PROTECTED_FILES) {
  const matching = changedFiles.filter((f) => f.startsWith(proto));
  if (matching.length) {
    warn(`Protected path touched: ${proto}`);
    for (const f of matching) {
      console.log(c.yellow(`    ${f}`));
    }
    protectedHits++;
  }
}
if (protectedHits === 0) {
  pass("No protected files modified");
}

// ── 6. Fork-exclusive paths ──────────────────────────────────────────────

section("Fork-exclusive paths");
const forkPaths = [
  "extensions/memory-l3/",
  "extensions/memory-core/",
  "src/skill-forge/",
  "src/agents/doom-loop-guard.ts",
  "src/agents/tool-loop-detection-config.ts",
];
let forkOk = true;
for (const p of forkPaths) {
  const exists = run(`test -e ${p}`);
  if (!exists.ok) {
    fail(`Missing: ${p}`);
    forkOk = false;
  }
}
if (forkOk) {
  pass("All fork-exclusive paths present");
}

// ── 7. .gitattributes merge=ours check ───────────────────────────────────

section(".gitattributes integrity");
const attrsBefore = run(`git show HEAD:.gitattributes`);
const attrsAfter = run("cat .gitattributes");
if (attrsBefore.ok && attrsAfter.ok) {
  const oursBefore = attrsBefore.stdout.split("\n").filter((l) => l.includes("merge=ours")).length;
  const oursAfter = attrsAfter.stdout.split("\n").filter((l) => l.includes("merge=ours")).length;
  if (oursAfter < oursBefore) {
    fail(`merge=ours entries DECREASED: ${oursBefore} → ${oursAfter}`);
    console.log(c.red("    This means upstream removed fork protection entries!"));
  } else if (oursAfter > oursBefore) {
    warn(`merge=ours entries increased: ${oursBefore} → ${oursAfter} (verify additions)`);
  } else {
    pass(`merge=ours entries unchanged (${oursBefore})`);
  }
} else {
  warn("Cannot compare .gitattributes");
}

// ── 8. TypeScript compilation ────────────────────────────────────────────

if (!skipTsc) {
  section("TypeScript compilation");
  const tsc = run("npx tsc --noEmit 2>&1", { timeout: 120000 });
  if (tsc.ok || tsc.code === 0) {
    pass("TypeScript compiles cleanly");
  } else {
    const errors = (tsc.stdout || tsc.stderr || "").split("\n").slice(0, 5);
    fail("TypeScript compilation errors:");
    for (const e of errors) {
      console.log(c.red(`    ${e}`));
    }
    if (errors.length >= 5) {
      console.log(c.dim("    ... (truncated)"));
    }
  }
} else {
  section("TypeScript compilation (skipped)");
}

// ── 9. Post-merge baseline drift ─────────────────────────────────────────

section("Post-merge config drift");
const drift = run("node scripts/fork-config-snapshot.mjs verify");
if (drift.code === 1) {
  warn("Config drift detected post-merge — expected if upstream changed configs");
  warn("After merge, run: node scripts/fork-config-snapshot.mjs generate");
} else {
  pass("No config drift");
}

// ── Summary ──────────────────────────────────────────────────────────────

console.log("");
console.log(c.bold("─".repeat(50)));

if (failures === 0) {
  console.log(c.green(`✓ Merge is SAFE — ${warnings} warning(s), 0 failures`));
  if (doApply) {
    console.log(c.bold("\nCommitting merge..."));
    const commit = run('git commit -m "Merge upstream into main (guard-approved)"');
    if (commit.ok) {
      console.log(c.green("✓ Merge committed"));
      console.log(c.yellow("\nNext steps:"));
      console.log(c.yellow("  1. Run full test suite"));
      console.log(
        c.yellow("  2. node scripts/fork-config-snapshot.mjs generate  # update baseline"),
      );
      console.log(c.yellow("  3. Verify gateway starts and works"));
    } else {
      fail("Commit failed");
      run("git merge --abort");
    }
  } else {
    console.log(c.yellow("\nTo apply: git commit"));
    console.log(c.dim("  Or re-run with --apply to auto-commit"));
    console.log(c.yellow("\nAbort with: git merge --abort"));
  }
} else {
  console.log(c.red(`✗ ${failures} problem(s) found — DO NOT MERGE`));
  console.log(c.yellow("\nAborting merge..."));
  run("git merge --abort");
  console.log(c.yellow("Merge aborted. Fix issues and retry."));
}

process.exit(failures > 0 ? 1 : 0);
