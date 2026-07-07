// Unit coverage for the pure helper in scripts/upstream-merge-engine.mjs. The
// git/worktree-driven main() is validated by running the engine in shadow mode.
import { describe, expect, it } from "vitest";
import { parseUnmergedStatus } from "../../scripts/upstream-merge-engine.mjs";

describe("parseUnmergedStatus", () => {
  it("counts only the unmerged status codes and returns their paths", () => {
    const porcelain = [
      "UU src/a.ts",
      "AA src/b.ts",
      "DU src/c.ts",
      "UD src/d.ts",
      "AU src/e.ts",
      "UA src/f.ts",
      "DD src/g.ts",
      " M src/normal.ts",
      "?? new.ts",
      "A  staged.ts",
    ].join("\n");
    const { counts, files } = parseUnmergedStatus(porcelain);
    expect(counts).toEqual({ UU: 1, AA: 1, DU: 1, UD: 1, AU: 1, UA: 1, DD: 1 });
    expect(files).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "src/f.ts",
      "src/g.ts",
    ]);
  });

  it("returns empty results for a clean (fully merged) status", () => {
    const { counts, files } = parseUnmergedStatus(" M a.ts\n?? b.ts\n");
    expect(counts).toEqual({});
    expect(files).toEqual([]);
  });
});
