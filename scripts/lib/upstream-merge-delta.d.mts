export type UnresolvedImportFinding = {
  kind: "unresolved-import";
  file: string;
  line: number;
  specifier: string;
};
export type ForkExportDriftFinding = {
  kind: "fork-export-drift";
  file: string;
  symbols: string[];
  fileDropped: boolean;
};
export type CountLiteralDisagreementFinding = {
  kind: "count-literal-disagreement";
  file: string;
  ours: string;
  theirs: string;
};
export type RelativeModuleSpecifier = { specifier: string; line: number };
/**
 * Conflict hunks whose sides disagree on a number, i.e. where neither side can be
 * taken because the literal counts something about the merged tree. Reads worktree
 * text with conflict markers still present.
 */
export function findCountLiteralDisagreements(params: {
  files: Iterable<string>;
  readSource: (file: string) => string | undefined;
}): CountLiteralDisagreementFinding[];
/**
 * The exported names of a source file. `export * from` records the sentinel `*`.
 */
export function collectExportedNames(sourceText: string, fileName?: string): Set<string>;
/**
 * Every relative module specifier, including dynamic `import()` and type-position
 * `import("./x")`.
 */
export function collectRelativeModuleSpecifiers(
  sourceText: string,
  fileName?: string,
): RelativeModuleSpecifier[];
/**
 * Repo-relative paths a relative specifier could resolve to, ESM `.js`-to-source
 * rewrite included.
 */
export function resolutionCandidates(fromPath: string, specifier: string): string[];
/**
 * Relative imports the merge broke: resolvable on an input side, unresolvable in
 * the merge result. Omitting `inputTreePaths` reports unresolved imports
 * absolutely, which on a real tree is dominated by generated `dist/` targets.
 */
export function findUnresolvedRelativeImports(params: {
  files: Iterable<string>;
  treePaths: Set<string> | Iterable<string>;
  inputTreePaths?: Set<string> | Iterable<string>;
  readSource: (file: string) => string | undefined;
}): UnresolvedImportFinding[];
/**
 * Fork-only exports the merge result lacks: `fork - upstream - merged`.
 *
 * `mergedExportIndex` holds every name exported anywhere in the merged tree;
 * symbols found there moved rather than vanished and are counted in `relocated`
 * instead of reported.
 */
export function findForkExportDrift(params: {
  files: Iterable<string>;
  mergedExportIndex?: Set<string>;
  readSource: (side: "base" | "upstream" | "fork" | "merged", file: string) => string | undefined;
}): { findings: ForkExportDriftFinding[]; relocated: string[] };
