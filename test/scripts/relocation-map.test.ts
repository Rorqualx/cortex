// Unit coverage for the pure helpers in scripts/relocation-map.mjs (the git-driven
// main() is validated by running the tool on the repo; these lock the parsing/matching).
import { describe, expect, it } from "vitest";
import {
  areaOf,
  globToRegExp,
  parseMergeOursGlobs,
  parseRenameStatus,
} from "../../scripts/relocation-map.mjs";

describe("globToRegExp", () => {
  it("matches ** across slashes and * within a segment", () => {
    expect(globToRegExp("extensions/codex/**").test("extensions/codex/src/x.ts")).toBe(true);
    expect(globToRegExp("src/skill-forge/**").test("src/skill-forge/a/b.ts")).toBe(true);
    expect(globToRegExp("ui/src/*.ts").test("ui/src/app.ts")).toBe(true);
    // * does not cross a slash
    expect(globToRegExp("ui/src/*.ts").test("ui/src/sub/app.ts")).toBe(false);
  });

  it("treats a trailing-slash glob as a directory prefix (matches dir and children)", () => {
    const re = globToRegExp("extensions/memory-l3/");
    expect(re.test("extensions/memory-l3")).toBe(true);
    expect(re.test("extensions/memory-l3/index.ts")).toBe(true);
    expect(re.test("extensions/memory-l3x")).toBe(false);
  });

  it("escapes regex metacharacters in literal path segments", () => {
    expect(globToRegExp("a.b/c+d.ts").test("a.b/c+d.ts")).toBe(true);
    expect(globToRegExp("a.b/c+d.ts").test("aXb/cYd.ts")).toBe(false);
  });
});

describe("parseMergeOursGlobs", () => {
  it("extracts merge=ours globs and skips comments/blanks/other attrs", () => {
    const text = [
      "# a comment",
      "",
      "extensions/memory-l3/** merge=ours",
      "src/skill-forge/**   merge=ours",
      "*.png binary",
      "docs/foo.md text=auto",
    ].join("\n");
    expect(parseMergeOursGlobs(text)).toEqual(["extensions/memory-l3/**", "src/skill-forge/**"]);
  });
});

describe("parseRenameStatus", () => {
  it("parses R/C rename records and ignores M/A/D", () => {
    const text = [
      "R100\told/a.ts\tnew/a.ts",
      "R087\tui/src/ui/x.ts\tui/src/x.ts",
      "C075\tsrc/base.ts\tsrc/copy.ts",
      "M\tsrc/keep.ts",
      "A\tsrc/added.ts",
      "D\tsrc/gone.ts",
    ].join("\n");
    expect(parseRenameStatus(text)).toEqual([
      { oldPath: "old/a.ts", newPath: "new/a.ts", score: 100 },
      { oldPath: "ui/src/ui/x.ts", newPath: "ui/src/x.ts", score: 87 },
      { oldPath: "src/base.ts", newPath: "src/copy.ts", score: 75 },
    ]);
  });
});

describe("areaOf", () => {
  it("buckets by top-level, keeping the platform segment for apps/", () => {
    expect(areaOf("src/agents/x.ts")).toBe("src");
    expect(areaOf("extensions/zai/index.ts")).toBe("extensions");
    expect(areaOf("apps/ios/Sources/x.swift")).toBe("apps/ios");
    expect(areaOf("packages/ai/src/x.ts")).toBe("packages");
    expect(areaOf(".gitattributes")).toBe("root");
    expect(areaOf("pnpm-workspace.yaml")).toBe("root");
  });
});
