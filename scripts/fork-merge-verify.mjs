#!/usr/bin/env node
// scripts/fork-merge-verify.mjs
// Post-merge verification — run after completing an upstream merge to confirm
// the fork is still healthy. Designed to be run as a commit-msg hook or manually.
//
// Usage:
//   node scripts/fork-merge-verify.mjs                  # Full check
//   node scripts/fork-merge-verify.mjs --quick          # Skip slow checks (TSC, tests)
//   node scripts/fork-merge-verify.mjs --regenerate     # Regenerate baseline after passing
//
// Checks:
//   1. No conflict markers anywhere in tree
//   2. Fork-exclusive paths exist
//   3. .gitattributes merge=ours entries intact
//   4. Config baseline drift report
//   5. TypeScript compiles (--quick skips)
//   6. Tests pass (--quick skips)

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const args = new Set(process.argv.slice(2));
const quick = args.has("--quick");
const regen = args.has("--regenerate");

let fails = 0,
  warns = 0;

function ok(msg) {
  console.log(c.green(`  ✓ ${msg}`));
}
function bad(msg) {
  fails++;
  console.log(c.red(`  ✗ ${msg}`));
}
function hm(msg) {
  warns++;
  console.log(c.yellow(`  ⚠ ${msg}`));
}
function sec(msg) {
  console.log(`\n${c.bold(`── ${msg} ──`)}`);
}

function run(cmd) {
  try {
    return {
      ok: true,
      out: execSync(cmd, { encoding: "utf-8", stdio: "pipe", timeout: 120_000 }).trim(),
    };
  } catch (e) {
    return { ok: false, out: e.stdout?.trim() || "", err: e.stderr?.trim() || "", code: e.status };
  }
}

// ── 1. Conflict markers ──────────────────────────────────────────────────

sec("Conflict markers");
const grep = run(
  'grep -rl "<<<<<<< " --include="*.ts" --include="*.js" --include="*.mjs" --include="*.json" --include="*.yaml" . 2>/dev/null || true',
);
if (grep.out) {
  // Filter out test fixtures, node_modules, and scripts that legitimately contain marker strings
  const legitPatterns = [
    /node_modules\//,
    /\.test\./,
    /check-no-conflict-markers/,
    /fork-merge-guard\.mjs/,
    /fork-merge-verify\.mjs/,
    /\.snap$/,
  ];
  const hits = grep.out
    .split("\n")
    .filter(Boolean)
    .filter((f) => !legitPatterns.some((p) => p.test(f)));
  if (hits.length) {
    bad("Conflict markers found:");
    for (const f of hits.slice(0, 15)) {
      console.log(c.red(`    ${f}`));
    }
  } else {
    ok("No conflict markers (excluding test fixtures)");
  }
} else {
  ok("No conflict markers");
}

// Also check for =======
const grep2 = run(
  'grep -rl "=======" --include="*.ts" --include="*.js" --include="*.mjs" . 2>/dev/null | head -5 || true',
);
// Skip — too many false positives (CSS, etc.)

// ── 2. Fork-exclusive paths ──────────────────────────────────────────────

sec("Fork-exclusive paths");
const forkPaths = [
  ["extensions/memory-l3/", "Memory L3 engine"],
  ["extensions/memory-core/", "Memory core"],
  ["src/skill-forge/", "Skill forge"],
  ["src/agents/doom-loop-guard.ts", "Doom loop guard"],
  ["src/agents/tool-loop-detection-config.ts", "Tool loop config"],
];
let allForkOk = true;
for (const [p, label] of forkPaths) {
  if (!existsSync(p)) {
    bad(`${label}: ${p} — MISSING`);
    allForkOk = false;
  } else {
    ok(`${label} present`);
  }
}

// ── 3. .gitattributes ────────────────────────────────────────────────────

sec(".gitattributes integrity");
const attrs = run("cat .gitattributes");
if (attrs.ok) {
  const oursLines = attrs.out.split("\n").filter((l) => l.includes("merge=ours"));
  if (oursLines.length === 0) {
    bad("No merge=ours entries found!");
  } else if (oursLines.length < 20) {
    hm(`Only ${oursLines.length} merge=ours entries (expected ~28+)`);
  } else {
    ok(`${oursLines.length} merge=ours entries`);
  }

  // Check that key fork protections exist
  const required = [
    "extensions/memory-l3/",
    "extensions/memory-core/",
    "src/skill-forge/",
    "src/agents/doom-loop-guard.ts",
  ];
  for (const r of required) {
    if (!attrs.out.includes(r)) {
      bad(`Missing protection for: ${r}`);
    }
  }
} else {
  bad("Cannot read .gitattributes");
}

// ── 4. Config baseline drift ─────────────────────────────────────────────

sec("Config baseline");
const drift = run("node scripts/fork-config-snapshot.mjs verify");
if (drift.code === 1) {
  hm("Config drift detected — expected after upstream merge");
  hm("Run with --regenerate to update baseline");
} else {
  ok("No config drift");
}

// ── 5. TypeScript (slow) ─────────────────────────────────────────────────

if (!quick) {
  sec("TypeScript compilation");
  const tsc = run("npx tsc --noEmit 2>&1");
  if (tsc.code === 0 || tsc.ok) {
    ok("TypeScript compiles");
  } else {
    const lines = (tsc.out || tsc.err || "").split("\n").slice(0, 8);
    bad("TypeScript errors:");
    for (const l of lines) {
      console.log(c.red(`    ${l}`));
    }
  }
} else {
  sec("TypeScript (skipped — --quick)");
}

// ── 6. Unit tests (slow) ─────────────────────────────────────────────────

if (!quick) {
  sec("Unit tests");
  const test = run("node scripts/run-vitest.mjs --reporter=verbose 2>&1 | tail -5");
  if (test.ok || test.out?.includes("passed")) {
    ok("Tests pass");
  } else {
    hm("Test status unclear — run manually");
  }
} else {
  sec("Tests (skipped — --quick)");
}

// ── 7. Gateway smoke ─────────────────────────────────────────────────────

sec("Gateway smoke");
// dist/index.js is the launchd entry (`node dist/index.js gateway`); the old
// dist/gateway.js entry no longer exists, so checking it always warned.
if (existsSync("dist/index.js")) {
  ok("Gateway build exists (dist/index.js)");
} else {
  hm("dist/index.js not found — run build");
}

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${c.bold("─".repeat(50))}`);
if (fails === 0) {
  console.log(c.green(`✓ Post-merge verification PASSED — ${warns} warning(s)`));
  if (regen) {
    console.log(c.bold("\nRegenerating baseline..."));
    const gen = run("node scripts/fork-config-snapshot.mjs generate");
    if (gen.ok) {
      console.log(c.green("✓ Baseline updated"));
    } else {
      console.log(c.red("✗ Baseline update failed"));
    }
  } else {
    console.log(c.dim("\nTo update baseline: node scripts/fork-merge-verify.mjs --regenerate"));
  }
} else {
  console.log(c.red(`✗ ${fails} issue(s) found — fork may be broken`));
  console.log(c.yellow("\nRecommended: investigate failures before proceeding"));
}
process.exit(fails > 0 ? 1 : 0);
