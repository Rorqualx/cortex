#!/usr/bin/env node
// Read-only upstream relocation map.
//
// Upstream sometimes MOVES files/dirs (e.g. ui/src/ui/* -> ui/src/*,
// src/llm/providers/* -> packages/ai/src/providers/*). When a moved file is
// fork-protected (`.gitattributes merge=ours`) or fork-modified, git's rename
// detection conflicts the fork's edits at the OLD path against the NEW path, and
// the fork's protection no longer covers the NEW location. This tool detects
// those fork-relevant relocations so protection and edits can be remapped BEFORE
// a merge. It mutates nothing — only `git` plumbing reads.
//
// Usage: node scripts/relocation-map.mjs [--upstream <ref>] [--head <ref>]
//                                        [--rename-threshold <pct>] [--pretty] [--json-only]
// Output: JSON on stdout; --pretty adds a human summary on stderr.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28 });
}

// --- Pure helpers (exported for tests) --------------------------------------

// Minimal glob->regex mirroring scripts/upstream-divergence-report.mjs so the
// protected-surface definition stays identical across the two tools.
export function globToRegExp(glob) {
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
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + (prefixDir ? "(/.*)?$" : "$"));
}

export function parseMergeOursGlobs(gitattributesText) {
  const globs = [];
  for (const raw of gitattributesText.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !/\bmerge=ours\b/.test(line)) continue;
    const glob = line.split(/\s+/)[0];
    if (glob) globs.push(glob);
  }
  return globs;
}

// Parse `git diff --name-status -M` output into rename records. Handles the
// rename status line shape `R<score>\t<old>\t<new>` (and copies `C<score>`).
export function parseRenameStatus(nameStatusText) {
  const renames = [];
  for (const line of nameStatusText.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status[0] !== "R" && status[0] !== "C") continue;
    const oldPath = parts[1];
    const newPath = parts[2];
    if (!oldPath || !newPath) continue;
    renames.push({ oldPath, newPath, score: Number(status.slice(1)) || 0 });
  }
  return renames;
}

// Coarse top-level area for grouping (apps/ keeps its platform segment).
export function areaOf(file) {
  const seg = file.split("/");
  const top = seg[0];
  if (top === "apps" && seg[1]) return `apps/${seg[1]}`;
  if (["src", "extensions", "ui", "docs", "packages", "scripts", "test", ".github"].includes(top)) {
    return top;
  }
  return "root";
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
  const renameThreshold = flag("--rename-threshold", "40");
  const pretty = argv.includes("--pretty");

  const base = git(["merge-base", head, upstream]).trim();

  const globs = parseMergeOursGlobs(readFileSync(resolve(repoRoot, ".gitattributes"), "utf8"));
  // Codex is folded into openai and never auto-touched; mirror the classifier.
  globs.push("extensions/codex/**");
  const protectors = globs.map((g) => ({ glob: g, re: globToRegExp(g) }));
  const protectedBy = (file) => {
    for (const { glob, re } of protectors) if (re.test(file)) return glob;
    return null;
  };

  const forkModified = new Set(
    git(["diff", "--name-only", base, head]).split("\n").filter(Boolean),
  );

  const renames = parseRenameStatus(
    git(["diff", `-M${renameThreshold}%`, "--find-renames", "--name-status", base, upstream]),
  );

  const forkRelevant = [];
  for (const r of renames) {
    const protectedByOld = protectedBy(r.oldPath);
    const forkTouched = forkModified.has(r.oldPath);
    if (!protectedByOld && !forkTouched) continue;
    const protectedByNew = protectedBy(r.newPath);
    forkRelevant.push({
      oldPath: r.oldPath,
      newPath: r.newPath,
      score: r.score,
      forkModified: forkTouched,
      protectedByOld,
      protectedByNew,
      // Protection gap: old path was merge=ours-protected, new path is NOT — the
      // fork loses protection on the moved file unless .gitattributes is remapped.
      protectionGap: Boolean(protectedByOld) && !protectedByNew,
      area: areaOf(r.newPath),
    });
  }

  const byArea = {};
  for (const r of forkRelevant) byArea[r.area] = (byArea[r.area] ?? 0) + 1;
  const protectionGaps = forkRelevant.filter((r) => r.protectionGap);

  const report = {
    base,
    head,
    upstream,
    renameThreshold: Number(renameThreshold),
    totalRenames: renames.length,
    forkRelevantRenames: forkRelevant.length,
    counts: {
      protectionGaps: protectionGaps.length,
      forkModifiedMoved: forkRelevant.filter((r) => r.forkModified).length,
      byArea,
    },
    // Actionable: merge=ours globs to add so protection follows the moved files.
    proposedGitattributesRemaps: protectionGaps.map((r) => ({
      wasGlob: r.protectedByOld,
      addPath: r.newPath,
      from: r.oldPath,
    })),
    forkRelevant,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  if (pretty) {
    const lines = [
      "",
      "=== upstream relocation map ===",
      `base=${base.slice(0, 12)} upstream=${upstream}  (rename threshold ${renameThreshold}%)`,
      `upstream renames: ${renames.length} · fork-relevant: ${forkRelevant.length} · protection gaps: ${protectionGaps.length}`,
      "fork-relevant relocations by area: " +
        Object.entries(byArea)
          .sort((a, b) => b[1] - a[1])
          .map(([a, n]) => `${a}=${n}`)
          .join(" "),
      "",
      "PROTECTION GAPS (merge=ours file moved; protection must follow):",
      ...protectionGaps
        .slice(0, 40)
        .map((r) => `  ${r.oldPath}  ->  ${r.newPath}   (was ${r.protectedByOld})`),
      protectionGaps.length > 40 ? `  … ${protectionGaps.length - 40} more` : "",
      "",
    ];
    process.stderr.write(lines.filter((l) => l !== undefined).join("\n") + "\n");
  }
}

// Only run when invoked directly, not when imported by tests.
if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) {
  main();
}
