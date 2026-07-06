// Unit coverage for the pure helpers in scripts/resync-ledger.mjs (the git/merge-tree
// driven main() is validated by running the tool on the repo).
import { describe, expect, it } from "vitest";
import { categorizeFile, parseMergeTree } from "../../scripts/resync-ledger.mjs";

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
