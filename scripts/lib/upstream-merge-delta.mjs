// Fork-side loss detection for upstream merges.
//
// scripts/cron-upstream-merge.sh already gates the UPSTREAM direction: dropped
// upstream files, and upstream exports missing from `merge=ours` files. Nothing
// gates the FORK direction, so every fork-side loss surfaces only as a downstream
// tsgo error — one per preflight cycle — or, when a definition and its only
// consumer are dropped together, not at all.
//
// These are the pure halves (AST + set math); scripts/check-upstream-merge-delta.mjs
// owns the git plumbing so this stays unit-testable without a repository.
import ts from "typescript";

/**
 * Parses one source file. `allowJs`-style syntax only — no program, no type
 * resolution, so this stays fast enough to run over a whole merged tree.
 */
function parseSource(sourceText, fileName) {
  return ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function collectBindingNames(name, into) {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  // `export const { a, b } = ...` / `export const [a] = ...` still export names.
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingNames(element.name, into);
      }
    }
  }
}

/**
 * The exported NAMES of a source file, as a Set.
 *
 * Names rather than lines: upstream reformats constantly, so a line-level compare
 * reads `export const S = Type.Object(` and `export const S = closedObject(` as
 * two different exports. The shell twin of this (sorted_export_names in
 * cron-upstream-merge.sh) hand-rolls comment and template-literal state machines
 * to avoid counting `export` inside a comment or a backtick body; parsing gets
 * both right by construction.
 *
 * `export * from "./x"` cannot be enumerated without resolving the target, so it
 * is recorded as the sentinel `*` — a caller comparing two files that both
 * re-export the same star sees no difference, which is the correct answer.
 */
export function collectExportedNames(sourceText, fileName = "input.ts") {
  const names = new Set();
  const source = parseSource(sourceText, fileName);
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      names.add("default");
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        names.add("*");
        continue;
      }
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.add(element.name.text);
        }
        continue;
      }
      // `export * as ns from "./x"`
      if (ts.isNamespaceExport(statement.exportClause)) {
        names.add(statement.exportClause.name.text);
      }
      continue;
    }
    if (!hasExportModifier(statement)) {
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
      continue;
    }
    if (statement.name && ts.isIdentifier(statement.name)) {
      names.add(statement.name.text);
    }
  }
  return names;
}

/**
 * Every relative module specifier in a source file, with its line.
 *
 * Static imports alone are not enough: the 2026-08-03 merge left
 * `server-methods/sessions.js` reachable only through a lazy `import()`, so a
 * regex over `from "..."` reported the tree clean while the gateway could not
 * route sessions at all. Dynamic `import()`, `export ... from`, and type-position
 * `import("./x")` all resolve at runtime or build time and all belong here.
 */
export function collectRelativeModuleSpecifiers(sourceText, fileName = "input.ts") {
  const source = parseSource(sourceText, fileName);
  const found = [];
  const record = (node) => {
    if (!node || !ts.isStringLiteralLike(node)) {
      return;
    }
    const specifier = node.text;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      return;
    }
    found.push({
      specifier,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        record(node.moduleReference.expression);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(node.arguments[0]);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) {
        record(node.argument.literal);
      }
    }
    ts.forEachChild(node, visit);
  };
  // setParentNodes is off, so getStart needs the source file passed explicitly;
  // that is why `record` closes over `source` rather than walking parents.
  ts.forEachChild(source, visit);
  return found;
}

const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];

function normalizeTreePath(candidate) {
  const segments = [];
  for (const segment of candidate.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Candidate repo-relative paths a relative specifier could resolve to.
 *
 * The repo is ESM TypeScript: source says `./x.js` and means `./x.ts`, so the
 * `.js`-to-source rewrite is the common case, not a fallback.
 */
export function resolutionCandidates(fromPath, specifier) {
  const directory = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const joined = normalizeTreePath(`${directory}/${specifier}`);
  if (!joined) {
    return [];
  }
  const candidates = [joined];
  const jsExtension = RESOLUTION_EXTENSIONS.find(
    (extension) =>
      joined.endsWith(extension) && [".js", ".mjs", ".cjs", ".jsx"].includes(extension),
  );
  if (jsExtension) {
    const stem = joined.slice(0, -jsExtension.length);
    for (const extension of RESOLUTION_EXTENSIONS) {
      candidates.push(`${stem}${extension}`);
    }
    candidates.push(`${stem}.d.ts`);
  } else {
    for (const extension of RESOLUTION_EXTENSIONS) {
      candidates.push(`${joined}${extension}`);
    }
    candidates.push(`${joined}.d.ts`);
  }
  for (const extension of RESOLUTION_EXTENSIONS) {
    candidates.push(`${joined}/index${extension}`);
  }
  return candidates;
}

/**
 * Relative imports the MERGE broke: resolvable on an input side, unresolvable in
 * the merge result.
 *
 * Regression rather than absolute, because a repo this size always carries
 * imports that resolve to nothing in the tree and are fine — `scripts/e2e/*`
 * clients import `../../dist/**` build output by design, and a handful of stale
 * script references predate this merge entirely. Reporting those buried the two
 * real drops under twelve non-issues on the 2026-08-03 fixture. Testing the
 * target against the input sides expresses the actual question ("did the merge
 * drop this module?") and needs no `dist`-shaped exclusion list to maintain.
 *
 * Resolution is set membership against tree listings rather than the filesystem,
 * so this answers for the merge INDEX mid-run and for any historical commit.
 */
export function findUnresolvedRelativeImports({ files, treePaths, inputTreePaths, readSource }) {
  const paths = treePaths instanceof Set ? treePaths : new Set(treePaths);
  const inputPaths =
    inputTreePaths === undefined
      ? undefined
      : inputTreePaths instanceof Set
        ? inputTreePaths
        : new Set(inputTreePaths);
  const findings = [];
  for (const file of files) {
    const sourceText = readSource(file);
    if (sourceText === undefined) {
      continue;
    }
    for (const { specifier, line } of collectRelativeModuleSpecifiers(sourceText, file)) {
      const candidates = resolutionCandidates(file, specifier);
      if (candidates.some((candidate) => paths.has(candidate))) {
        continue;
      }
      if (inputPaths && !candidates.some((candidate) => inputPaths.has(candidate))) {
        continue;
      }
      findings.push({ kind: "unresolved-import", file, line, specifier });
    }
  }
  return findings;
}

// Two-digit-plus only. Single digits are array indices, enum ordinals and `+ 1`
// arithmetic; they disagree constantly and mean nothing. Every real instance of
// this trap so far has been an inventory count well above 9.
const COUNT_LITERAL_RE = /\b\d{2,}\b/gu;

function countLiterals(lines) {
  return [...new Set(lines.join("\n").match(COUNT_LITERAL_RE) ?? [])].toSorted().join(",");
}

/**
 * Conflict hunks whose two sides disagree on a number.
 *
 * These are the hunks where picking a side is wrong whichever side you pick: the
 * literal counts something about the MERGED tree, so both inputs are stale by
 * construction and the value has to be re-measured after resolving. On 2026-08-03
 * `check-protocol-registry.mjs` offered 55 against upstream's 53 while the merged
 * tree held 56, and `server-methods-list.test.ts` carried two more.
 *
 * Reads worktree text with the conflict markers still in it — between staging and
 * resolution is the only window where both sides are visible. Tolerates diff3
 * markers, which add a `|||||||` base section.
 */
export function findCountLiteralDisagreements({ files, readSource }) {
  const findings = [];
  for (const file of files) {
    const sourceText = readSource(file);
    if (sourceText === undefined) {
      continue;
    }
    let side = null;
    let hunk = null;
    for (const line of sourceText.split("\n")) {
      if (line.startsWith("<<<<<<<")) {
        side = "ours";
        hunk = { ours: [], base: [], theirs: [] };
        continue;
      }
      if (hunk && line.startsWith("|||||||")) {
        side = "base";
        continue;
      }
      if (hunk && line.startsWith("=======")) {
        side = "theirs";
        continue;
      }
      if (hunk && line.startsWith(">>>>>>>")) {
        const ours = countLiterals(hunk.ours);
        const theirs = countLiterals(hunk.theirs);
        if (ours !== "" && theirs !== "" && ours !== theirs) {
          findings.push({ kind: "count-literal-disagreement", file, ours, theirs });
        }
        side = null;
        hunk = null;
        continue;
      }
      if (hunk && side) {
        hunk[side].push(line);
      }
    }
  }
  return findings;
}

/**
 * Fork exports upstream does not carry that the merge result lacks:
 * `fork - upstream - merged`.
 *
 * NOT the mirror of check_merge_ours_export_drift. That gate computes
 * `(upstream - base) - merged`, subtracting the base so long-standing fork
 * deletions stay quiet. Subtracting the base here suppresses the fork-loss shape
 * instead of noise: `registerAgentRunContext` sat in base and fork, never in
 * upstream, and the 2026-08-03 merge dropped it — a base subtraction filtered
 * that out and the detector reported a clean tree.
 *
 * Excluding upstream's own exports is what keeps this quiet. A symbol both sides
 * carry cannot be fork work, so ordinary upstream refactors and adopted upstream
 * deletions never fire; only a symbol that exists solely because the fork wrote
 * it, and is now gone, is reported.
 *
 * Callers pass only files present on the fork side — a file the fork deleted on
 * purpose is not drift.
 */
export function findForkExportDrift({ files, readSource, mergedExportIndex }) {
  const relocated = mergedExportIndex ?? new Set();
  const findings = [];
  const relocatedSymbols = [];
  for (const file of files) {
    const forkSource = readSource("fork", file);
    if (forkSource === undefined) {
      continue;
    }
    const upstreamSource = readSource("upstream", file);
    const mergedSource = readSource("merged", file);
    const forkNames = collectExportedNames(forkSource, file);
    const upstreamNames =
      upstreamSource === undefined ? new Set() : collectExportedNames(upstreamSource, file);
    // A file the merge dropped entirely loses every fork export in it, which is a
    // finding rather than a reason to skip: `merged` missing is the worst case.
    const mergedNames =
      mergedSource === undefined ? new Set() : collectExportedNames(mergedSource, file);
    const gone = [...forkNames].filter(
      (name) => name !== "*" && !upstreamNames.has(name) && !mergedNames.has(name),
    );
    // A symbol still exported somewhere in the merged tree moved, it did not
    // vanish. Upstream refactors relocate constantly — it moved the whole run
    // context registry out of infra/agent-events.ts into infra/agent-run-registry.ts
    // — and a per-file check reads every one of those as fork loss. Broken wiring
    // after a move surfaces as an unresolved import or a tsgo error instead.
    const missing = gone.filter((name) => !relocated.has(name));
    for (const name of gone) {
      if (relocated.has(name)) {
        relocatedSymbols.push(`${file}:${name}`);
      }
    }
    if (missing.length === 0) {
      continue;
    }
    findings.push({
      kind: "fork-export-drift",
      file,
      symbols: missing.toSorted(),
      fileDropped: mergedSource === undefined,
    });
  }
  // Relocations are reported as a count, not silently dropped: a run that
  // suppressed 40 of them is a different situation from one that suppressed none.
  return { findings, relocated: relocatedSymbols.toSorted() };
}
