// Behavior coverage for the merge=ours loss reporting in
// scripts/cron-upstream-merge.sh. These functions decide whether a nightly merge
// silently discards upstream work, and their failure mode is invisible to every
// other lane (tsgo type-checks against the stale file that is actually present),
// so they are exercised against real git merges rather than mocked.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// fileURLToPath, not URL.pathname: the latter percent-encodes spaces and
// non-ASCII, so a checkout under such a path would hand bash an unopenable name.
const SCRIPT = fileURLToPath(new URL("../../scripts/cron-upstream-merge.sh", import.meta.url));

let repo: string;
let scratch: string;

// /dev/null for both config scopes: the fixtures run real commits, so a developer
// or CI machine with commit.gpgsign or core.hooksPath set would fail the suite for
// reasons unrelated to the code under test.
const ISOLATED_GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...ISOLATED_GIT_ENV },
  });
}

/**
 * Source the script (its top-level config is all env-overridable) and call one
 * function, so the assertions cover the shipped code path rather than a copy.
 */
function callScriptFn(fn: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(
      "bash",
      ["-c", `set -uo pipefail; source "${SCRIPT}" >/dev/null 2>&1 || true; ${fn}`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...ISOLATED_GIT_ENV,
          UPSTREAM_MERGE_MAIN: repo,
          UPSTREAM_REF: "upstream",
          UPSTREAM_MERGE_LOG: join(scratch, "ledger.log"),
          UPSTREAM_MERGE_TMPDIR: scratch,
        },
      },
    );
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

/** base -> upstream branch (their edit) + main (our edit), then merge upstream in. */
function buildForkedMerge(opts: { ourEdit: string; theirEdit: string; protect: boolean }) {
  writeFileSync(join(repo, "mod.ts"), "export const kept = 1;\nconst internal = 2;\n");
  writeFileSync(join(repo, ".gitattributes"), opts.protect ? "mod.ts merge=ours\n" : "\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("branch", "upstream");

  git("checkout", "-q", "upstream");
  writeFileSync(join(repo, "mod.ts"), opts.theirEdit);
  git("commit", "-qam", "upstream edit");

  git("checkout", "-q", "main");
  writeFileSync(join(repo, "mod.ts"), opts.ourEdit);
  // An unedited fork side must stay at the base commit — committing it anyway
  // (empty) would still leave main == base, but git refuses the empty commit.
  if (git("status", "--porcelain").trim() !== "") {
    git("commit", "-qam", "fork edit");
  }
  // --no-commit leaves the merged result in the index, which is the state
  // stage_init inspects.
  try {
    git("merge", "--no-commit", "--no-ff", "upstream");
  } catch {
    /* conflict or ours-driver resolution both leave the index populated */
  }
}

beforeEach(() => {
  // realpath: macOS os.tmpdir() is a /var -> /private/var symlink, and git
  // reports canonical paths, so raw mkdtemp paths mismatch on Mac but pass on
  // Linux CI.
  repo = realpathSync(mkdtempSync(join(tmpdir(), "um-drift-repo-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "um-drift-tmp-")));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  // `ours` is NOT a built-in gitattributes merge driver (only text/binary/union
  // are); it resolves through merge.ours.driver, which this repo sets in its
  // untracked .git/config. Without it `merge=ours` conflicts instead of keeping
  // our side, and none of this reporting has anything to look at.
  git("config", "merge.ours.driver", "true");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("report_merge_ours_drift", () => {
  it("reports a protected file whose upstream delta the merge discarded", () => {
    buildForkedMerge({
      protect: true,
      ourEdit: "export const kept = 1;\nconst internal = 2;\nconst forkOnly = 3;\n",
      theirEdit: "export const kept = 1;\nconst internal = 22;\nconst upstreamOnly = 4;\n",
    });
    const base = git("rev-parse", "main~1").trim();
    const { stdout } = callScriptFn(`report_merge_ours_drift "${repo}" "${base}"`);
    expect(stdout).toContain("MERGE-OURS-DRIFT mod.ts");
    expect(stdout).toContain("MERGE-OURS-DRIFT-COUNT 1");
  });

  it("does not report a protected file the fork never edited", () => {
    // The `ours` driver only runs when both sides changed; with no fork delta the
    // file merges to upstream normally and nothing is lost. Reporting it anyway
    // is what buried the real losses under harmless entries.
    buildForkedMerge({
      protect: true,
      ourEdit: "export const kept = 1;\nconst internal = 2;\n",
      theirEdit: "export const kept = 1;\nconst internal = 22;\n",
    });
    const base = git("rev-parse", "main").trim();
    const { stdout } = callScriptFn(`report_merge_ours_drift "${repo}" "${base}"`);
    expect(stdout).not.toContain("MERGE-OURS-DRIFT mod.ts");
    expect(stdout).toContain("MERGE-OURS-DRIFT-COUNT 0");
  });
});

describe("report_dropped_upstream_files", () => {
  /** Upstream adds a file the fork has never seen; leaves the merge uncommitted. */
  function mergeWithUpstreamNewFile(): string {
    writeFileSync(join(repo, "mod.ts"), "export const kept = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    git("branch", "upstream");

    git("checkout", "-q", "upstream");
    writeFileSync(join(repo, "brand-new.ts"), "export const fresh = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "upstream adds a file");

    git("checkout", "-q", "main");
    writeFileSync(join(repo, "mod.ts"), "export const kept = 1;\nconst forkOnly = 3;\n");
    git("commit", "-qam", "fork edit");
    git("merge", "--no-commit", "--no-ff", "upstream");
    return base;
  }

  it("reads the merge result from the index, not pre-merge HEAD", () => {
    // This runs mid `merge --no-commit`, where HEAD is still pre-merge main. Reading
    // HEAD reported every upstream-new file as dropped (447 phantoms against a true
    // 2 on the real tree), which buried the real ones.
    const base = mergeWithUpstreamNewFile();
    const { stdout } = callScriptFn(`report_dropped_upstream_files "${repo}" "${base}"`);
    expect(stdout).not.toContain("DROPPED-UPSTREAM brand-new.ts");
    expect(stdout).toContain("DROPPED-UPSTREAM-COUNT 0");
  });

  it("reports an upstream-new file the merge really did drop", () => {
    const base = mergeWithUpstreamNewFile();
    // Stands in for a resolution step that discards it, as the ui policy does.
    git("rm", "-q", "-f", "brand-new.ts");
    const { stdout } = callScriptFn(`report_dropped_upstream_files "${repo}" "${base}"`);
    expect(stdout).toContain("DROPPED-UPSTREAM brand-new.ts");
    expect(stdout).toContain("DROPPED-UPSTREAM-COUNT 1");
  });
});

describe("sorted_export_names", () => {
  it("extracts the exported binding from each export form", () => {
    // The gate subtracts these sets, so a form the parser mangles either invents a
    // name the operator cannot hand-carry (spurious nightly block) or hides a real
    // rename. `export type * from` in particular used to yield the phantom `from`.
    writeFileSync(
      join(repo, "x.ts"),
      [
        'export * from "./a";',
        // Keyed by specifier so a second star re-export is a distinct element.
        'export * from "./a2";',
        'export type * from "./b";',
        'export * as ns from "./c";',
        "export default foo;",
        "export { a, b as c };",
        "export { x, type T };",
        "export const { d, e } = obj;",
        "export const { orig: renamed } = obj;",
        // Default values are not part of the bound name.
        "export const { withDefault = 1 } = obj;",
        "export const [f, g] = arr;",
        "export declare async function h() {}",
        "export function* gen() {}",
        "export async function* agen() {}",
        "export type I = number;",
        // Grouped type re-export is a list, not a `type` declaration.
        'export type { Foo, Baz as Qux } from "./t";',
        "export{j};",
        // Accepted gap: only `A` is tracked. Splitting declarator commas to catch
        // `B` invented far more phantom names than it found real ones (82 vs 3 on
        // this tree), and a one-sided phantom fails the gate on an unchanged
        // surface — a worse failure than missing this rare form.
        "export const A = 1, B = 2;",
        "export const enum E {}",
        // None of these commas introduce a binding.
        "export const O = { p: 1, q: 2 };",
        "export const R = fn(1, 2);",
        "export const m: Record<string, number> = {};",
        'export const SEP = ", ";',
        "export const FOO = 1; // used by bar, baz",
        // Commas in generic parameter and heritage lists are not extra bindings.
        "export function withGenerics<T2, U2>(v: T2): U2 {}",
        "export type Pair<A2, B2> = [A2, B2];",
        "export class Widget extends Base<C2, D2> implements I1, I2 {}",
        // `/*` inside a string is not a comment opener; treating it as one swallows
        // every export below it until some unrelated `*/` appears. (A `**/*` glob
        // happens to self-close as `/**/`; a trailing `/*` is the one that bites.)
        'export const URLPAT = "https://example.com/*";',
        "export const afterUrl = 1;",
        // An unbalanced quote inside a one-line block comment blanks its own close
        // in the masked copy; the close must be found on the raw line instead.
        "export const quoteCmt = 1; /* don't use */",
        "export const afterQuoteCmt = 1;",
        // Same latch via a line comment or an escaped quote inside a literal.
        "export const lineCmt = 1; // matches src/*",
        "export const afterLineComment = 1;",
        'export const escaped = "a\\"b/*";',
        "export const afterEscaped = 1;",
        // A commented-out export is not an export, wherever the block opens.
        "/*",
        "export const commentedOut = 9;",
        "*/",
        "const notExported = 1; /*",
        "export const midLineCommented = 9;",
        "*/",
        "/* one-liner: export const inlineComment = 9; */",
        "/* lead */ export const afterInline = 9;",
        // A template literal body is not code; a generator emitting `export ...`
        // lines would otherwise register phantom exports.
        "const tpl = `",
        "export const insideTemplate = 9;",
        "/* not a comment either",
        "`;",
        "export const afterTemplate = 1;",
        // Comments inside a grouped list are not exported names, and a `}` inside
        // one must not close the list early.
        "export {",
        "  k, // kept for now, use m instead",
        "  /* note */ l as m,",
        "  type N,",
        "};",
      ].join("\n"),
    );
    git("add", "-A");
    git("commit", "-qm", "forms");
    const { stdout } = callScriptFn(`sorted_export_names "${repo}" "main:x.ts"`);
    expect(stdout.trim().split("\n")).toEqual([
      "*:./a",
      "*:./a2",
      "*:./b",
      "A",
      "E",
      "FOO",
      "Foo",
      "I",
      "N",
      "O",
      "Pair",
      "Qux",
      "R",
      "SEP",
      "T",
      "URLPAT",
      "Widget",
      "a",
      "afterEscaped",
      "afterInline",
      "afterLineComment",
      "afterQuoteCmt",
      "afterTemplate",
      "afterUrl",
      "agen",
      "c",
      "d",
      "default",
      "e",
      "escaped",
      "f",
      "g",
      "gen",
      "h",
      "j",
      "k",
      "lineCmt",
      "m",
      "ns",
      "quoteCmt",
      "renamed",
      "withDefault",
      "withGenerics",
      "x",
    ]);
  });
});

describe("check_merge_ours_export_drift", () => {
  it("fails when the discarded upstream delta changed the export surface", () => {
    buildForkedMerge({
      protect: true,
      ourEdit: "export const kept = 1;\nconst internal = 2;\nconst forkOnly = 3;\n",
      theirEdit: "export const kept = 1;\nexport const added = 9;\nconst internal = 2;\n",
    });
    const base = git("rev-parse", "main~1").trim();
    const { stdout, status } = callScriptFn(`check_merge_ours_export_drift "${repo}" "${base}"`);
    expect(status).toBe(1);
    expect(stdout).toContain("PREFLIGHT=FAIL reason=merge-ours-export-drift");
    expect(stdout).toContain("mod.ts");
  });

  it("passes when upstream only moved an export line", () => {
    // A relocated/rewrapped export shows up in the unified diff as both a -export
    // and a +export line while the surface is unchanged; failing the nightly on
    // that would block landing over a pure upstream refactor.
    buildForkedMerge({
      protect: true,
      ourEdit: "export const kept = 1;\nconst internal = 2;\nconst forkOnly = 3;\n",
      theirEdit: "const internal = 2;\nconst other = 5;\nexport const kept = 1;\n",
    });
    const base = git("rev-parse", "main~1").trim();
    const { stdout, status } = callScriptFn(`check_merge_ours_export_drift "${repo}" "${base}"`);
    expect(status).toBe(0);
    expect(stdout).not.toContain("PREFLIGHT=FAIL");
  });

  it("fails on a brace-form export the space-anchored regex would miss", () => {
    buildForkedMerge({
      protect: true,
      ourEdit: "export const kept = 1;\nconst internal = 2;\nconst forkOnly = 3;\n",
      theirEdit: "export const kept = 1;\nconst internal = 2;\nconst n = 7;\nexport{n};\n",
    });
    const base = git("rev-parse", "main~1").trim();
    const { stdout, status } = callScriptFn(`check_merge_ours_export_drift "${repo}" "${base}"`);
    expect(status).toBe(1);
    expect(stdout).toContain("PREFLIGHT=FAIL reason=merge-ours-export-drift");
  });

  it("clears once upstream's new export is hand-carried into our copy", () => {
    // The remediation the failure message prescribes has to be able to turn the
    // gate green. Comparing base against upstream could not: the base only moves
    // when a merge lands, and the gate is what blocks landing.
    buildForkedMerge({
      protect: true,
      ourEdit: "export const kept = 1;\nexport const added = 9;\nconst forkOnly = 3;\n",
      theirEdit: "export const kept = 1;\nexport const added = 9;\nconst internal = 22;\n",
    });
    const base = git("rev-parse", "main~1").trim();
    const { stdout, status } = callScriptFn(`check_merge_ours_export_drift "${repo}" "${base}"`);
    expect(status).toBe(0);
    expect(stdout).not.toContain("PREFLIGHT=FAIL");
  });

  it("ignores exports the fork adds on top of upstream's surface", () => {
    buildForkedMerge({
      protect: true,
      ourEdit: "export const kept = 1;\nexport const forkOnly = 3;\n",
      theirEdit: "export const kept = 1;\nconst internal = 22;\n",
    });
    const base = git("rev-parse", "main~1").trim();
    const { stdout, status } = callScriptFn(`check_merge_ours_export_drift "${repo}" "${base}"`);
    expect(status).toBe(0);
    expect(stdout).not.toContain("PREFLIGHT=FAIL");
  });

  it("ignores an export the fork dropped that upstream never touched", () => {
    // Long-standing fork divergence is not this merge's doing, and gating on it
    // is unclearable. Real case: the fork deleted 32 SkillsCurator*/SkillsProposal*
    // exports from agents-models-skills.ts before this merge base; upstream
    // changed none of them, so the merge drops nothing.
    writeFileSync(join(repo, "mod.ts"), "export const kept = 1;\nexport const legacy = 2;\n");
    writeFileSync(join(repo, ".gitattributes"), "mod.ts merge=ours\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("branch", "upstream");

    git("checkout", "-q", "upstream");
    writeFileSync(
      join(repo, "mod.ts"),
      "export const kept = 1;\nexport const legacy = 2;\nconst n = 3;\n",
    );
    git("commit", "-qam", "upstream internal edit");

    git("checkout", "-q", "main");
    writeFileSync(join(repo, "mod.ts"), "export const kept = 1;\nconst forkOnly = 3;\n");
    git("commit", "-qam", "fork drops legacy");
    try {
      git("merge", "--no-commit", "--no-ff", "upstream");
    } catch {
      /* ours-driver resolution still populates the index */
    }

    const base = git("rev-parse", "main~1").trim();
    const { stdout, status } = callScriptFn(`check_merge_ours_export_drift "${repo}" "${base}"`);
    expect(status).toBe(0);
    expect(stdout).not.toContain("PREFLIGHT=FAIL");
  });

  it("ignores an upstream reformat that keeps the exported name", () => {
    // Upstream rewrote `Type.Object(` to `closedObject(` across the protocol
    // schemas; comparing whole export LINES read that as ~80 lost exports on one
    // file. Only the names matter.
    buildForkedMerge({
      protect: true,
      ourEdit: "export const S = Type.Object({});\nconst forkOnly = 3;\n",
      theirEdit: "export const S = closedObject({});\nconst internal = 22;\n",
    });
    const base = git("rev-parse", "main~1").trim();
    const { stdout, status } = callScriptFn(`check_merge_ours_export_drift "${repo}" "${base}"`);
    expect(status).toBe(0);
    expect(stdout).not.toContain("PREFLIGHT=FAIL");
  });

  it("passes when the discarded upstream delta is internal only", () => {
    // Losing internal upstream edits is the accepted cost of protecting a file;
    // only the export surface can break a module the fork did adopt.
    buildForkedMerge({
      protect: true,
      ourEdit: "export const kept = 1;\nconst internal = 2;\nconst forkOnly = 3;\n",
      theirEdit: "export const kept = 1;\nconst internal = 22;\nconst other = 5;\n",
    });
    const base = git("rev-parse", "main~1").trim();
    const { stdout, status } = callScriptFn(`check_merge_ours_export_drift "${repo}" "${base}"`);
    expect(status).toBe(0);
    expect(stdout).not.toContain("PREFLIGHT=FAIL");
  });
});
