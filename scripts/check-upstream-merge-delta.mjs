#!/usr/bin/env node

// Fork-side preflight for upstream merges: what did WE lose?
//
// cron-upstream-merge.sh gates the upstream direction only (dropped upstream
// files, upstream exports missing from `merge=ours` files). Fork-side loss has no
// gate, so it surfaces one defect per tsgo cycle — the 2026-08-03 resync found
// four upstream-deleted modules with live fork importers serially, each costing a
// full preflight run — or never, when a definition and its only consumer are
// dropped together and the tree still compiles.
//
// Reads git objects, never the worktree, so it answers for the merge INDEX
// mid-run (`--merged :0`, the default) and for any historical merge commit.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Inlined from scripts/lib/failed-trailer.mjs, which upstream deleted in the
// TypeScript migration (#121005); a plain .mjs cannot import the migrated .mts.
// Keeps wrapper failures visible even when preceding diagnostics are truncated.
async function runWithFailedTrailer(tool, run, log = console.error) {
  try {
    await run();
  } catch (error) {
    log(error);
    process.exitCode = 1;
  }
  if (typeof process.exitCode === "number" && process.exitCode !== 0) {
    log(`[${tool}] FAILED (exit ${process.exitCode})`);
  }
}
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  collectExportedNames,
  findCountLiteralDisagreements,
  findForkExportDrift,
  findUnresolvedRelativeImports,
} from "./lib/upstream-merge-delta.mjs";

const TOOL = "check:upstream-merge-delta";
// Roots whose loss breaks a build or a runtime route. `ui/` is fork-owned by
// policy (apply_fork_ui_ownership keeps our whole tree), so upstream never
// removes anything from it and scanning it would only add ~90% of the volume.
const SCANNED_ROOTS = ["src/", "packages/", "extensions/", "scripts/"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".js", ".jsx"];

function git(repo, args, { maxBuffer = 512 * 1024 * 1024 } = {}) {
  const result = spawnSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    maxBuffer,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.trim() || result.status}`);
  }
  return result.stdout;
}

function isScannedSource(file) {
  if (!SCANNED_ROOTS.some((root) => file.startsWith(root))) {
    return false;
  }
  if (file.includes("/node_modules/")) {
    return false;
  }
  if (file.endsWith(".d.ts") || file.endsWith(".d.mts")) {
    return false;
  }
  return SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension));
}

/**
 * Reads many git objects in one `cat-file --batch`. Per-object `git show` over an
 * 8k-file tree costs minutes; the batch protocol costs one process.
 */
function readObjects(repo, specs) {
  const contents = new Map();
  if (specs.length === 0) {
    return contents;
  }
  const result = spawnSync("git", ["-C", repo, "cat-file", "--batch"], {
    input: `${specs.join("\n")}\n`,
    maxBuffer: 2048 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git cat-file --batch failed: ${result.stderr?.toString().trim()}`);
  }
  const buffer = result.stdout;
  let offset = 0;
  for (const spec of specs) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline === -1) {
      break;
    }
    const header = buffer.toString("utf8", offset, newline);
    offset = newline + 1;
    // `<spec> missing` — the object is absent on that side, which is itself an
    // answer (a dropped file), so it is recorded as undefined rather than thrown.
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
      continue;
    }
    const size = Number.parseInt(header.slice(header.lastIndexOf(" ") + 1), 10);
    if (!Number.isFinite(size)) {
      break;
    }
    contents.set(spec, buffer.toString("utf8", offset, offset + size));
    offset += size + 1;
  }
  return contents;
}

function parseArgs(argv) {
  const options = { merged: ":0", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--conflicts") {
      options.conflicts = true;
      continue;
    }
    const value = argv[index + 1];
    if (argument === "--repo") {
      options.repo = value;
    } else if (argument === "--base") {
      options.base = value;
    } else if (argument === "--fork") {
      options.fork = value;
    } else if (argument === "--upstream") {
      options.upstream = value;
    } else if (argument === "--merged") {
      options.merged = value;
    } else {
      continue;
    }
    index += 1;
  }
  return options;
}

function objectSpec(ref, file) {
  // `:0` is the index stage, spelled `:0:<path>`; a commit-ish is `<ref>:<path>`.
  return ref === ":0" ? `:0:${file}` : `${ref}:${file}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = options.repo ?? resolveRepoRoot(import.meta.url);

  // Runs against the unresolved worktree rather than git objects: conflict markers
  // are the subject, and they exist nowhere else. Needs no refs, so it is checked
  // before the ref requirement below.
  if (options.conflicts) {
    const unmerged = git(repo, ["diff", "--name-only", "--diff-filter=U"])
      .split("\n")
      .filter(Boolean);
    const findings = findCountLiteralDisagreements({
      files: unmerged,
      readSource: (file) => {
        try {
          return readFileSync(join(repo, file), "utf8");
        } catch {
          return undefined;
        }
      },
    });
    if (options.json) {
      console.log(JSON.stringify({ unmerged: unmerged.length, findings }, null, 2));
    } else {
      for (const finding of findings) {
        console.log(
          `  COUNT-DISAGREEMENT ${finding.file}: ours=[${finding.ours}] upstream=[${finding.theirs}]`,
        );
      }
      console.log(
        `COUNT-DISAGREEMENT-SCAN ${unmerged.length} conflicted files, ${findings.length} hunks where neither side can be taken`,
      );
      if (findings.length > 0) {
        console.log("  Re-measure these against the merged tree; both sides are stale by");
        console.log("  construction, so picking either one is wrong.");
      }
    }
    return;
  }

  if (!options.base || !options.fork || !options.upstream) {
    throw new Error(
      "--base <merge-base>, --fork <fork tip merged in> and --upstream <upstream ref> are required",
    );
  }

  const listTree = (ref) =>
    (ref === ":0" ? git(repo, ["ls-files"]) : git(repo, ["ls-tree", "-r", "--name-only", ref]))
      .split("\n")
      .filter(Boolean);
  const treePaths = new Set(listTree(options.merged));
  // Union of the two inputs: a module absent here was never in this merge to
  // lose, so an import of it is pre-existing rather than merge damage.
  // Upstream's `ui/` is excluded because apply_fork_ui_ownership keeps the fork's
  // whole `ui/` tree by policy — an upstream-only `ui/` path is deliberately not
  // adopted, so counting it as an input made every stale script reference into it
  // read as merge damage.
  const inputTreePaths = new Set([
    ...listTree(options.fork),
    ...listTree(options.upstream).filter((file) => !file.startsWith("ui/")),
  ]);

  // D1 — relative imports the merge broke.
  const mergedSources = [...treePaths].filter(isScannedSource);
  const mergedSpecs = mergedSources.map((file) => objectSpec(options.merged, file));
  const mergedContents = readObjects(repo, mergedSpecs);
  const unresolved = findUnresolvedRelativeImports({
    files: mergedSources,
    treePaths,
    inputTreePaths,
    readSource: (file) => mergedContents.get(objectSpec(options.merged, file)),
  });

  // D2 — fork-only exports the merge result lacks. Scoped to the fork delta: a
  // file the fork never touched cannot have lost fork work.
  const forkDelta = git(repo, ["diff", "--name-only", options.base, options.fork])
    .split("\n")
    .filter((file) => file && isScannedSource(file));
  const driftContents = new Map();
  for (const [side, ref] of [
    ["base", options.base],
    ["upstream", options.upstream],
    ["fork", options.fork],
    ["merged", options.merged],
  ]) {
    const contents = readObjects(
      repo,
      forkDelta.map((file) => objectSpec(ref, file)),
    );
    driftContents.set(side, { ref, contents });
  }
  // Every name exported anywhere in the merged tree, so a symbol upstream merely
  // moved to another module is not reported as fork loss.
  const mergedExportIndex = new Set();
  for (const file of mergedSources) {
    const sourceText = mergedContents.get(objectSpec(options.merged, file));
    if (sourceText === undefined) {
      continue;
    }
    for (const name of collectExportedNames(sourceText, file)) {
      mergedExportIndex.add(name);
    }
  }
  const { findings: drift, relocated } = findForkExportDrift({
    files: forkDelta,
    mergedExportIndex,
    readSource: (side, file) => {
      const entry = driftContents.get(side);
      return entry.contents.get(objectSpec(entry.ref, file));
    },
  });

  const findings = [...unresolved, ...drift];
  if (options.json) {
    console.log(
      JSON.stringify(
        { scanned: mergedSources.length, forkDelta: forkDelta.length, relocated, findings },
        null,
        2,
      ),
    );
  } else {
    for (const finding of unresolved) {
      console.log(`  UNRESOLVED-IMPORT ${finding.file}:${finding.line} -> ${finding.specifier}`);
    }
    for (const finding of drift) {
      const suffix = finding.fileDropped ? " (file dropped by the merge)" : "";
      console.log(`  FORK-EXPORT-DRIFT ${finding.file}${suffix}: ${finding.symbols.join(", ")}`);
    }
    console.log(
      `FORK-DELTA-SCAN ${mergedSources.length} merged sources, ${forkDelta.length} fork-delta files, ` +
        `${unresolved.length} imports broken by the merge, ${drift.length} files losing fork exports ` +
        `(${relocated.length} symbols relocated, not lost)`,
    );
  }
  if (findings.length > 0) {
    // --json keeps stdout parseable: the findings array carries the detail and the
    // exit code carries the verdict, so the operator guidance below would only
    // corrupt the document.
    if (options.json) {
      process.exitCode = 1;
      return;
    }
    console.log("PREFLIGHT=FAIL reason=fork-delta-loss");
    console.log("  Imports above resolve to nothing, or fork exports are absent from the merge.");
    console.log("  Restore each at its owning file before shipping proof; tsgo finds these one");
    console.log("  per cycle, and finds nothing at all when a definition and its only consumer");
    console.log("  are dropped together.");
    process.exitCode = 1;
  }
}

await runWithFailedTrailer(TOOL, main);
