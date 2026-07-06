// Unit coverage for the pure helpers in scripts/resync-ledger.mjs (the git/merge-tree
// driven main() is validated by running the tool on the repo).
import { describe, expect, it } from "vitest";
import {
  categorizeFile,
  fileClassOf,
  parseMergeTree,
  planBatches,
  riskTierOf,
} from "../../scripts/resync-ledger.mjs";

describe("parseMergeTree", () => {
  it("collects conflicted paths (deduped across stages) and conflict-type counts", () => {
    const out = [
      "a1b2c3d4treeoid",
      "100644 aaa 1\tsrc/a.ts",
      "100644 bbb 2\tsrc/a.ts",
      "100644 ccc 3\tsrc/a.ts",
      "100644 ddd 1\tui/src/b.ts",
      "",
      "CONFLICT (content): Merge conflict in src/a.ts",
      "CONFLICT (file location): ui/src/ui/b.ts -> ui/src/b.ts",
      "CONFLICT (modify/delete): docs/c.md deleted in HEAD",
    ].join("\n");
    const { conflictedPaths, conflictTypes } = parseMergeTree(out);
    expect([...conflictedPaths].sort()).toEqual(["src/a.ts", "ui/src/b.ts"]);
    expect(conflictTypes).toEqual({ content: 1, "file location": 1, "modify/delete": 1 });
  });

  it("returns empty sets for a clean merge (only the tree oid line)", () => {
    const { conflictedPaths, conflictTypes } = parseMergeTree("cleantreeoid\n");
    expect(conflictedPaths.size).toBe(0);
    expect(conflictTypes).toEqual({});
  });
});

describe("categorizeFile", () => {
  const cat = (o: Partial<Parameters<typeof categorizeFile>[0]>) =>
    categorizeFile({
      forkChanged: false,
      upstreamChanged: false,
      conflicted: false,
      mergeOurs: false,
      relocated: false,
      ...o,
    });

  it("non-conflicting files route by which side changed", () => {
    expect(cat({ upstreamChanged: true })).toBe("adopt");
    expect(cat({ forkChanged: true })).toBe("keep");
    expect(cat({ forkChanged: true, upstreamChanged: true })).toBe("auto");
  });

  it("conflicting files route merge=ours -> relocate -> resolve, in priority order", () => {
    expect(
      cat({ conflicted: true, forkChanged: true, upstreamChanged: true, mergeOurs: true }),
    ).toBe("keep-ours");
    // merge=ours wins even if also relocated (driver auto-resolves it)
    expect(cat({ conflicted: true, mergeOurs: true, relocated: true })).toBe("keep-ours");
    expect(cat({ conflicted: true, relocated: true })).toBe("relocate");
    expect(cat({ conflicted: true, forkChanged: true, upstreamChanged: true })).toBe("resolve");
  });
});

describe("fileClassOf", () => {
  it("classifies tests, docs, swift, config, and source", () => {
    expect(fileClassOf("src/agents/x.test.ts")).toBe("test");
    expect(fileClassOf("apps/ios/Tests/RootTabsTests.swift")).toBe("test");
    expect(fileClassOf("docs/cli/gateway.md")).toBe("doc");
    expect(fileClassOf("apps/ios/Sources/RootTabs.swift")).toBe("swift");
    expect(fileClassOf("package.json")).toBe("config");
    expect(fileClassOf("pnpm-workspace.yaml")).toBe("config");
    expect(fileClassOf("src/agents/system-prompt.ts")).toBe("source");
  });
});

describe("riskTierOf", () => {
  it("tiers tests/docs/isolated-dirs low, config/extensions medium, runtime source high", () => {
    expect(riskTierOf("src", "test")).toBe("low");
    expect(riskTierOf("docs", "doc")).toBe("low");
    expect(riskTierOf("apps/ios", "swift")).toBe("low");
    expect(riskTierOf("root", "config")).toBe("medium");
    expect(riskTierOf("extensions", "source")).toBe("medium");
    expect(riskTierOf("src", "source")).toBe("high");
    expect(riskTierOf("ui", "source")).toBe("high");
  });
});

describe("planBatches", () => {
  it("orders low->medium->high, groups by area, and chunks by size", () => {
    const entries = [
      { file: "src/z.ts", area: "src", riskTier: "high" },
      { file: "docs/a.md", area: "docs", riskTier: "low" },
      { file: "extensions/b.ts", area: "extensions", riskTier: "medium" },
      { file: "docs/c.md", area: "docs", riskTier: "low" },
    ];
    const batches = planBatches(entries, 2);
    // First batch is the two low-risk docs; last file is the high-risk src.
    expect(batches[0].tier).toBe("low");
    expect(batches[0].files).toEqual(["docs/a.md", "docs/c.md"]);
    expect(batches.at(-1).files).toEqual(["src/z.ts"]);
    expect(batches.map((b) => b.tier)).toEqual(["low", "medium", "high"]);
  });
});
