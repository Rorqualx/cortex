#!/usr/bin/env node
// scripts/fork-config-snapshot.mjs
// Fork merge protection — baseline snapshot, verify, and diff for critical config files.
//
// Usage:
//   node scripts/fork-config-snapshot.mjs generate   # Create/update baseline snapshot
//   node scripts/fork-config-snapshot.mjs verify      # Verify current state against baseline
//   node scripts/fork-config-snapshot.mjs diff        # Show detailed drift report
//
// Part of the fork-merge-guard system. See FORK-MERGE-GUIDE.md for the full workflow.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";

// ── Configurable file lists ──────────────────────────────────────────────

const CRITICAL_FILES = [
  ".gitattributes",
  ".pre-commit-config.yaml",
  ".crabbox.yaml",
  ".oxlintrc.json",
  "tsconfig.json",
  "tsconfig.core.json",
  "tsconfig.extensions.json",
  "package.json",
  "src/config/schema.ts",
  "src/config/runtime-schema.ts",
];

const FORK_EXCLUSIVE_PATHS = [
  "extensions/memory-l3/",
  "extensions/memory-core/",
  "src/skill-forge/",
  "src/agents/doom-loop-guard.ts",
  "src/agents/tool-loop-detection-config.ts",
];

const BASELINE_FILE = "fork-config-baseline.json";

// ── Color helpers ────────────────────────────────────────────────────────

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

// ── Utilities ────────────────────────────────────────────────────────────

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const read = (p) => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
};
const pathOk = (p) => existsSync(p);

function git(...args) {
  try {
    return execSync(`git ${args.join(" ")}`, { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function jsonTopKeys(src) {
  try {
    return Object.keys(JSON.parse(src));
  } catch {
    return null;
  }
}

function gitattrMergeLines(src) {
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("merge=ours"));
}

function pkgSectionsHash(src) {
  try {
    const pkg = JSON.parse(src);
    const sections = {};
    for (const k of ["scripts", "dependencies", "devDependencies"]) {
      if (pkg[k] !== undefined) {
        sections[k] = pkg[k];
      }
    }
    return sha256(JSON.stringify(sections));
  } catch {
    return null;
  }
}

function fileInfo(path) {
  const src = read(path);
  if (src === null) {
    return null;
  }
  const info = { hash: sha256(src) };
  if (path === ".gitattributes") {
    info.mergeOursLines = gitattrMergeLines(src);
  }
  if (path.endsWith(".json") && path !== "package.json") {
    info.jsonKeys = jsonTopKeys(src);
  }
  if (path === "package.json") {
    info.pkgSectionsHash = pkgSectionsHash(src);
  }
  return info;
}

function buildSnapshot() {
  const branch = git("rev-parse --abbrev-ref HEAD");
  const headSha = git("rev-parse HEAD");
  if (!branch || !headSha) {
    console.error(c.red("Error: not in a git repository"));
    process.exit(1);
  }
  const files = {};
  for (const f of CRITICAL_FILES) {
    files[f] = fileInfo(f);
  }
  return { timestamp: new Date().toISOString(), branch, headSha, files };
}

// ── Commands ─────────────────────────────────────────────────────────────

function generate() {
  const snap = buildSnapshot();
  writeFileSync(BASELINE_FILE, JSON.stringify(snap, null, 2));
  const tracked = Object.keys(snap.files).filter((f) => snap.files[f] !== null).length;
  console.log(c.green(`✓ Baseline written to ${BASELINE_FILE}`));
  console.log(c.green(`  ${snap.branch} @ ${snap.headSha.slice(0, 12)}`));
  console.log(c.green(`  ${tracked}/${CRITICAL_FILES.length} files tracked`));
}

function verify() {
  const raw = read(BASELINE_FILE);
  if (!raw) {
    console.error(c.red(`Baseline not found. Run \`generate\` first.`));
    process.exit(1);
  }
  const baseline = JSON.parse(raw);
  const current = {};
  for (const f of CRITICAL_FILES) {
    current[f] = fileInfo(f);
  }

  let ok = true;
  const report = [];

  for (const f of CRITICAL_FILES) {
    const b = baseline.files[f],
      cur = current[f];
    if (b === null && cur === null) {
      report.push({ f, status: "PASS", detail: "" });
      continue;
    }
    if (b === null && cur !== null) {
      ok = false;
      report.push({ f, status: "NEW", detail: "appeared" });
      continue;
    }
    if (b !== null && cur === null) {
      ok = false;
      report.push({ f, status: "MISSING", detail: "disappeared" });
      continue;
    }

    const issues = [];
    if (b.hash !== cur.hash) {
      issues.push("hash");
    }
    if (JSON.stringify(b.jsonKeys?.toSorted()) !== JSON.stringify(cur.jsonKeys?.toSorted())) {
      issues.push("jsonKeys");
    }
    if (
      JSON.stringify(b.mergeOursLines?.toSorted()) !==
      JSON.stringify(cur.mergeOursLines?.toSorted())
    ) {
      issues.push("merge=ours lines");
    }
    if (b.pkgSectionsHash !== cur.pkgSectionsHash) {
      issues.push("pkg sections");
    }

    if (issues.length) {
      ok = false;
      report.push({ f, status: "DRIFT", detail: issues.join(", ") });
    } else {
      report.push({ f, status: "PASS", detail: "" });
    }
  }

  for (const p of FORK_EXCLUSIVE_PATHS) {
    if (!pathOk(p)) {
      ok = false;
      report.push({ f: p, status: "MISSING", detail: "fork path gone" });
    } else {
      report.push({ f: p, status: "PASS", detail: "" });
    }
  }

  for (const r of report) {
    const color = r.status === "PASS" ? c.green : r.status === "DRIFT" ? c.yellow : c.red;
    const detail = r.detail ? ` (${r.detail})` : "";
    console.log(color(`  ${r.status.padEnd(8)} ${r.f}${detail}`));
  }

  if (ok) {
    console.log(c.green("\n✓ All clear."));
    process.exit(0);
  } else {
    console.log(c.red("\n✗ Baseline drift detected."));
    process.exit(1);
  }
}

function diff() {
  const raw = read(BASELINE_FILE);
  if (!raw) {
    console.error(c.red("Baseline not found."));
    process.exit(1);
  }
  const baseline = JSON.parse(raw);
  const current = buildSnapshot();
  let any = false;

  for (const f of CRITICAL_FILES) {
    const b = baseline.files[f],
      cur = current.files[f];
    if (!b && !cur) {
      continue;
    }
    const changes = [];

    if (b && cur) {
      if (b.hash !== cur.hash) {
        changes.push(`hash ${b.hash.slice(0, 10)} → ${cur.hash.slice(0, 10)}`);
      }
      if (b.jsonKeys && cur.jsonKeys) {
        const added = cur.jsonKeys.filter((k) => !b.jsonKeys.includes(k));
        const gone = b.jsonKeys.filter((k) => !cur.jsonKeys.includes(k));
        if (added.length) {
          changes.push(`keys +${added}`);
        }
        if (gone.length) {
          changes.push(`keys -${gone}`);
        }
      }
      if (b.mergeOursLines && cur.mergeOursLines) {
        const added = cur.mergeOursLines.filter((l) => !b.mergeOursLines.includes(l));
        const gone = b.mergeOursLines.filter((l) => !cur.mergeOursLines.includes(l));
        if (added.length) {
          changes.push(`merge=ours +${added.length}`);
        }
        if (gone.length) {
          changes.push(`merge=ours -${gone.length}`);
        }
      }
      if (b.pkgSectionsHash !== cur.pkgSectionsHash) {
        changes.push("pkg sections changed");
      }
    } else if (!b) {
      changes.push("file appeared");
    } else {
      changes.push("file removed");
    }

    if (changes.length) {
      any = true;
      console.log(c.yellow(`\n  📄 ${f}`));
      for (const ch of changes) {
        console.log(`      ${c.dim("→")} ${ch}`);
      }
    }
  }

  for (const p of FORK_EXCLUSIVE_PATHS) {
    if (!pathOk(p)) {
      any = true;
      console.log(c.red(`\n  ⚠  ${p} — missing`));
    }
  }

  if (!any) {
    console.log(c.green("✓ No drift."));
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
if (cmd === "generate") {
  generate();
} else if (cmd === "verify") {
  verify();
} else if (cmd === "diff") {
  diff();
} else {
  console.error("Usage: fork-config-snapshot.mjs <generate|verify|diff>");
  process.exit(1);
}
