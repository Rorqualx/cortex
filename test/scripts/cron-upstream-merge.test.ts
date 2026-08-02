// Behavior coverage for scripts/cron-upstream-merge.sh: the merge=ours loss
// reporting, the stage-time reference pins, and the worktree lifecycle. All three
// fail invisibly to every other lane — tsgo type-checks against whatever stale file
// is actually present, and a gate that resolved the wrong ref reports a confident,
// specific, wrong answer — so they run against real git rather than mocks.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
function callScriptFn(
  fn: string,
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  // 2>&1 is deliberate for the caller that asks for it: load_stage_pins reports
  // which ref it resolved on stderr, and "it used the live ref silently" is exactly
  // the regression these tests exist to catch.
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
          UPSTREAM_MERGE_WORKTREE: join(scratch, "wt"),
          ...env,
        },
      },
    );
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

/** A single commit on main so worktree/pin fixtures have something to point at. */
function seedMain(): string {
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\n");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return git("rev-parse", "HEAD").trim();
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

describe("merge=ours drift gate baseline", () => {
  // The drift report reads the "ours" side from STAGE_BASELINE_REF, not live `main`.
  // With `main`, any protected file that a landed cron commit touched after staging
  // compared unequal, so `[ "$merged" = "$ours" ] || continue` dropped it from the
  // loss list — silently blinding the one gate built for the class tsgo cannot see.
  it("follows the pinned baseline rather than whatever main points at", () => {
    buildForkedMerge({
      protect: true,
      ourEdit: "export const kept = 1;\nconst internal = 2;\nconst forkOnly = 3;\n",
      theirEdit: "export const kept = 1;\nconst internal = 22;\nconst upstreamOnly = 4;\n",
    });
    const stagedTip = git("rev-parse", "main").trim();
    const mergeBase = git("rev-parse", "main~1").trim();
    const upstreamTip = git("rev-parse", "upstream").trim();

    // Drive it exactly as production does: stage_init writes the pins, load_stage_pins
    // reads them back into STAGE_OURS_REF. Pinned at the staged tip, merge=ours kept
    // precisely that blob, so the loss is visible.
    const br = "resync-staging/pin-test";
    git("branch", "-q", br, "main");
    const pinned = callScriptFn(
      `write_stage_pins "${br}" "${upstreamTip}" "${stagedTip}" 2>/dev/null;` +
        ` load_stage_pins "${br}" 2>/dev/null; report_merge_ours_drift "${repo}" "${mergeBase}"`,
      { UPSTREAM_REF: "" },
    );
    expect(pinned.stdout).toContain("MERGE-OURS-DRIFT-COUNT 1");

    // Re-pinned anywhere else, the blob no longer matches and the file drops out.
    // That divergence is the regression under test: if the report ever goes back to
    // reading live `main`, both assertions collapse to the same value.
    const mispinned = callScriptFn(
      `write_stage_pins "${br}" "${upstreamTip}" "${mergeBase}" 2>/dev/null;` +
        ` load_stage_pins "${br}" 2>/dev/null; report_merge_ours_drift "${repo}" "${mergeBase}"`,
      { UPSTREAM_REF: "" },
    );
    expect(mispinned.stdout).toContain("MERGE-OURS-DRIFT-COUNT 0");
  });
});

describe("preflight gate ordering", () => {
  // The pure-git gates run BEFORE the dependency install. A merge committed with
  // conflict markers in pnpm-lock.yaml used to kill the install first and surface as
  // a dependency problem, hiding the marker the next gate names in seconds.
  it("reports committed conflict markers without needing node_modules", () => {
    seedMain();
    writeFileSync(
      join(repo, "broken.ts"),
      "<<<<<<< HEAD\nexport const a = 1;\n=======\n>>>>>>> x\n",
    );
    git("add", "-A");
    git("commit", "-qm", "resolution with markers left in");
    const empty = join(scratch, "nopm");
    mkdirSync(empty, { recursive: true });
    const res = callScriptFn(`preflight "${repo}" 2>&1`, { PATH: `${empty}:/usr/bin:/bin` });
    expect(res.stdout).toContain("PREFLIGHT=FAIL reason=conflict-markers");
    expect(res.stdout).not.toContain("worktree-deps");
  });

  it("defers rather than failing when the local dependency install cannot run", () => {
    // The Mac's inability to install is the premise of the remote-proof design, so a
    // local install failure is evidence about the machine, not a verdict on the merge.
    seedMain();
    const empty = join(scratch, "nopm2");
    mkdirSync(empty, { recursive: true });
    const res = callScriptFn(`preflight "${repo}" 2>&1`, { PATH: `${empty}:/usr/bin:/bin` });
    expect(res.status).toBe(3);
    expect(res.stdout).toContain("PREFLIGHT=DEFER reason=worktree-deps");
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

describe("stage reference pins", () => {
  // UPSTREAM_REF is a remote-tracking ref and main advances nightly, so both moved
  // between staging a merge and proving it. Re-resolving them at prove time made the
  // export gate diff a staged merge against a FUTURE upstream and name ten untouched
  // files as dropped exports, and made the huey proof reject its own baseline as
  // "not an ancestor". Neither failure says anything about the merge being judged.
  function stageThenMove(): { pinnedUpstream: string; pinnedBaseline: string } {
    const pinnedBaseline = seedMain();
    git("branch", "-q", "upstream");
    git("checkout", "-q", "upstream");
    writeFileSync(join(repo, "up.txt"), "up1\n");
    git("add", "-A");
    git("commit", "-qm", "up1");
    const pinnedUpstream = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "main");
    git("branch", "-q", "resync-staging/2026-08-01", "main");
    callScriptFn(
      `write_stage_pins "resync-staging/2026-08-01" "${pinnedUpstream}" "${pinnedBaseline}"`,
      { UPSTREAM_REF: "" },
    );
    // Both live refs move, exactly as a `git fetch upstream` and a landed cron commit do.
    git("checkout", "-q", "upstream");
    writeFileSync(join(repo, "up.txt"), "up2\n");
    git("commit", "-qam", "up2");
    git("checkout", "-q", "main");
    writeFileSync(join(repo, "a.txt"), "a2\n");
    git("commit", "-qam", "main moved");
    return { pinnedUpstream, pinnedBaseline };
  }

  it("resolves the refs the merge was staged against, not where they point now", () => {
    const { pinnedUpstream, pinnedBaseline } = stageThenMove();
    const { stdout } = callScriptFn(
      `load_stage_pins "resync-staging/2026-08-01" 2>/dev/null; echo "$UPSTREAM_REF $STAGE_BASELINE_REF"`,
      { UPSTREAM_REF: "" },
    );
    expect(stdout.trim()).toBe(`${pinnedUpstream} ${pinnedBaseline}`);
    expect(pinnedUpstream).not.toBe(git("rev-parse", "upstream").trim());
    expect(pinnedBaseline).not.toBe(git("rev-parse", "main").trim());
  });

  it("still lets an explicit env value override the pin", () => {
    // The operator's escape hatch. It existed before and was silently swallowed by a
    // hardcoded `BASELINE_REF=main` at the call site, so this asserts the whole path.
    stageThenMove();
    const { stdout } = callScriptFn(
      `load_stage_pins "resync-staging/2026-08-01" 2>/dev/null; echo "$UPSTREAM_REF $STAGE_BASELINE_REF"`,
      { UPSTREAM_REF: "cafebabe", BASELINE_REF: "feedface" },
    );
    expect(stdout.trim()).toBe("cafebabe feedface");
  });

  it("says so when a branch has no pins instead of quietly using the live refs", () => {
    seedMain();
    const { stdout } = callScriptFn(
      `load_stage_pins "resync-staging/never-staged" 2>&1; echo "REF=$UPSTREAM_REF"`,
      { UPSTREAM_REF: "" },
    );
    expect(stdout).toContain("no upstream pin");
    expect(stdout).toContain("REF=upstream/main");
  });

  it("warns when a branch has no baseline pin instead of silently using live main", () => {
    seedMain();
    const { stdout } = callScriptFn(
      `load_stage_pins "resync-staging/never-staged" 2>&1; echo "BASE=$STAGE_BASELINE_REF"`,
      { UPSTREAM_REF: "" },
    );
    expect(stdout).toContain("no baseline pin");
    expect(stdout).toContain("BASE=main");
  });

  it("prunes a pin only once its staging branch is gone", () => {
    seedMain();
    git("branch", "-q", "resync-staging/keepme", "main");
    const head = git("rev-parse", "main").trim();
    const count = () =>
      callScriptFn(
        `prune_stage_pins; git -C "${repo}" for-each-ref refs/upstream-merge-pin/ | wc -l`,
        { UPSTREAM_REF: "" },
      ).stdout.trim();
    callScriptFn(`write_stage_pins "resync-staging/keepme" "${head}" "${head}"`, {
      UPSTREAM_REF: "",
    });
    expect(count()).toBe("2");
    git("branch", "-qD", "resync-staging/keepme");
    expect(count()).toBe("0");
  });
});

describe("worktree lifecycle", () => {
  // node_modules is the expensive part of a worktree and preflight (protocol-gen +
  // tsgo) cannot run without it, but the worktree was wipe-and-recreated on every
  // run — so the nightly could never pass its own gate. Reset in place instead.
  const wt = () => join(scratch, "wt");

  function seedWorktree(): void {
    seedMain();
    callScriptFn("fresh_worktree");
    mkdirSync(join(wt(), "node_modules"), { recursive: true });
    mkdirSync(join(wt(), "packages/x/node_modules"), { recursive: true });
    mkdirSync(join(wt(), "dist"), { recursive: true });
    writeFileSync(join(wt(), "node_modules/marker"), "dep\n");
    writeFileSync(join(wt(), "packages/x/node_modules/marker"), "nested\n");
    writeFileSync(join(wt(), "dist/junk.js"), "junk\n");
    writeFileSync(join(wt(), "stray.txt"), "junk\n");
    writeFileSync(join(wt(), "a.txt"), "locally dirtied\n");
  }

  it("keeps installed dependencies across a reset but restores everything else", () => {
    seedWorktree();
    const before = statSync(join(wt(), "node_modules/marker")).ino;
    callScriptFn("fresh_worktree");
    expect(existsSync(join(wt(), "node_modules/marker"))).toBe(true);
    // The gitignore pattern must spare the workspace packages' nested trees too,
    // or pnpm's workspace links break and the reinstall cost comes right back.
    expect(existsSync(join(wt(), "packages/x/node_modules/marker"))).toBe(true);
    expect(statSync(join(wt(), "node_modules/marker")).ino).toBe(before);
    expect(existsSync(join(wt(), "dist/junk.js"))).toBe(false);
    expect(existsSync(join(wt(), "stray.txt"))).toBe(false);
    expect(readFileSync(join(wt(), "a.txt"), "utf8")).toBe("a\n");
  });

  it("does not lose committed resolution work parked on a staging branch", () => {
    seedWorktree();
    execFileSync("git", ["-C", wt(), "checkout", "-qB", "resync-staging/keepme"], {
      env: { ...process.env, ...ISOLATED_GIT_ENV },
    });
    writeFileSync(join(wt(), "resolved.txt"), "r\n");
    execFileSync("git", ["-C", wt(), "add", "resolved.txt"], {
      env: { ...process.env, ...ISOLATED_GIT_ENV },
    });
    execFileSync("git", ["-C", wt(), "commit", "-qm", "resolution"], {
      env: { ...process.env, ...ISOLATED_GIT_ENV },
    });
    const kept = git("rev-parse", "resync-staging/keepme").trim();
    callScriptFn("fresh_worktree");
    expect(git("rev-parse", "resync-staging/keepme").trim()).toBe(kept);
  });

  it("releases the worktree warm rather than deleting it", () => {
    // Deleting it would drop the dependencies the reset exists to preserve, which is
    // how the previous `worktree remove` defeated the whole point every night.
    seedWorktree();
    callScriptFn("release_worktree");
    expect(existsSync(join(wt(), "node_modules/marker"))).toBe(true);
    // Clean, so the next run's dirty-tree guard does not SKIP on our own leftovers.
    const status = execFileSync("git", ["-C", wt(), "status", "--porcelain"], {
      encoding: "utf8",
      env: { ...process.env, ...ISOLATED_GIT_ENV },
    });
    expect(status.trim()).toBe("");
  });
});

describe("ensure_worktree_deps", () => {
  // Reinstalling on every run costs minutes; never reinstalling proves the merge
  // against the previous merge's dependency tree. Key on the lockfile.
  /**
   * Stub BOTH package managers and record their argv. The usability probe now runs
   * `corepack pnpm --version` before any install, so keying "did it install?" on the
   * stub merely being invoked made these assertions vacuous — and leaving pnpm
   * unstubbed let the fallback shell out to the developer's real pnpm against a
   * fixture tmpdir.
   */
  function withStubbedPackageManagers(fn: string, opts: { corepackWorks?: boolean } = {}) {
    const bin = join(scratch, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["corepack", "pnpm"]) {
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\necho "$@" >> "${join(scratch, `${name}.argv`)}"\n` +
          (name === "corepack" && opts.corepackWorks === false ? "exit 1\n" : "exit 1\n"),
        { mode: 0o755 },
      );
    }
    // A working corepack must still answer the probe; only the install fails.
    if (opts.corepackWorks) {
      writeFileSync(
        join(bin, "corepack"),
        `#!/bin/sh\necho "$@" >> "${join(scratch, "corepack.argv")}"\n` +
          `case "$*" in *--version*) exit 0 ;; *) exit 1 ;; esac\n`,
        { mode: 0o755 },
      );
    }
    // /usr/bin and /bin only for git and coreutils — no path to a real pnpm.
    const res = callScriptFn(fn, { PATH: `${bin}:/usr/bin:/bin` });
    const argv = (name: string) => {
      const f = join(scratch, `${name}.argv`);
      return existsSync(f) ? readFileSync(f, "utf8") : "";
    };
    return {
      ...res,
      probed: /pnpm --version/.test(argv("corepack")),
      installed: /(^|\n)install|pnpm install/.test(argv("corepack") + argv("pnpm")),
      corepackArgv: argv("corepack"),
      pnpmArgv: argv("pnpm"),
    };
  }
  it("skips the install when the lockfile matches what the deps were built from", () => {
    seedMain();
    callScriptFn("fresh_worktree");
    const wtDir = join(scratch, "wt");
    mkdirSync(join(wtDir, "node_modules"), { recursive: true });
    const hash = git("hash-object", join(wtDir, "pnpm-lock.yaml")).trim();
    writeFileSync(join(wtDir, "node_modules/.upstream-merge-lock-hash"), `${hash}\n`);
    const res = withStubbedPackageManagers(`ensure_worktree_deps "${wtDir}"`);
    expect(res.status).toBe(0);
    expect(res.installed).toBe(false);
    // Short-circuit means it returns before selecting a manager at all, so not even
    // the usability probe should have run.
    expect(res.probed).toBe(false);
    expect(res.pnpmArgv).toBe("");
  });

  it("installs when the merge moved the lockfile, and fails closed when that install fails", () => {
    seedMain();
    callScriptFn("fresh_worktree");
    const wtDir = join(scratch, "wt");
    mkdirSync(join(wtDir, "node_modules"), { recursive: true });
    writeFileSync(join(wtDir, "node_modules/.upstream-merge-lock-hash"), "stale\n");
    const res = withStubbedPackageManagers(`ensure_worktree_deps "${wtDir}"`);
    expect(res.installed).toBe(true);
    expect(res.pnpmArgv).toContain("install");
    // Non-zero matters: preflight turns this into a DEFER (or a FAIL when pnpm names
    // the lockfile) rather than running protocol-gen and tsgo against a dependency
    // tree that does not match the merge.
    expect(res.status).not.toBe(0);
  });

  it("falls back to pnpm when corepack is not installed", () => {
    // corepack ships with node on the Linux prover but is absent on the operator's
    // Mac, and cron's PATH is narrower still. Assuming it failed the install
    // instantly with "nice: corepack: No such file or directory", which reads as a
    // dependency problem rather than a missing tool.
    seedMain();
    callScriptFn("fresh_worktree");
    const bin = join(scratch, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "pnpm"),
      `#!/bin/sh\necho pnpm >> "${join(scratch, "pm.calls")}"\nexit 1\n`,
      { mode: 0o755 },
    );
    // No corepack on this PATH; git and node still resolve from the system dirs.
    const res = callScriptFn(`ensure_worktree_deps "${join(scratch, "wt")}" 2>&1`, {
      PATH: `${bin}:/usr/bin:/bin`,
    });
    expect(existsSync(join(scratch, "pm.calls"))).toBe(true);
    expect(res.stdout).toContain("via pnpm");
  });

  it("reports a missing package manager instead of failing as a dependency error", () => {
    seedMain();
    callScriptFn("fresh_worktree");
    const empty = join(scratch, "emptybin");
    mkdirSync(empty, { recursive: true });
    const res = callScriptFn(`ensure_worktree_deps "${join(scratch, "wt")}" 2>&1`, {
      PATH: `${empty}:/usr/bin:/bin`,
    });
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain("neither corepack nor pnpm is on PATH");
  });

  it("probes corepack for usability and still installs via it when the probe passes", () => {
    seedMain();
    callScriptFn("fresh_worktree");
    const res = withStubbedPackageManagers(`ensure_worktree_deps "${join(scratch, "wt")}"`, {
      corepackWorks: true,
    });
    expect(res.probed).toBe(true);
    expect(res.corepackArgv).toContain("install");
    // The probe must not be mistaken for the install: both are corepack invocations,
    // and keying on "corepack ran" is what made these assertions vacuous before.
    expect(res.installed).toBe(true);
  });

  it("installs when node_modules is absent entirely", () => {
    seedMain();
    callScriptFn("fresh_worktree");
    const res = withStubbedPackageManagers(`ensure_worktree_deps "${join(scratch, "wt")}"`);
    expect(res.installed).toBe(true);
  });
});
