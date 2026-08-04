// Fork-side merge-loss detectors. The cases below are the shapes the 2026-08-03
// resync actually produced; each one cost a preflight cycle or went unnoticed.
import { describe, expect, it } from "vitest";
import {
  collectExportedNames,
  collectRelativeModuleSpecifiers,
  findCountLiteralDisagreements,
  findForkExportDrift,
  findUnresolvedRelativeImports,
  resolutionCandidates,
} from "../../scripts/lib/upstream-merge-delta.mjs";

function sourcesOf(entries: Record<string, string | undefined>) {
  return (file: string) => entries[file];
}

describe("collectExportedNames", () => {
  it("collects every export form", () => {
    const names = collectExportedNames(`
      export const a = 1, b = 2;
      export function c() {}
      export class d {}
      export type e = string;
      export interface f { x: 1 }
      export enum g { A }
      export const { h, i } = obj;
      export { j, k as l } from "./x.js";
      export * as m from "./y.js";
      export default n;
    `);
    expect([...names].toSorted()).toEqual(
      ["a", "b", "c", "d", "default", "e", "f", "g", "h", "i", "j", "l", "m"].toSorted(),
    );
  });

  it("ignores non-exported declarations", () => {
    // The AgentPlanEventData shape: the fork exported it, the merge left it local.
    // That is a real surface regression, so `type X` must not read as `export type X`.
    expect([...collectExportedNames("type AgentPlanEventData = { a: 1 };")]).toEqual([]);
  });

  it("does not count `export` inside comments or template literals", () => {
    // The shell twin hand-rolls state machines for both; parsing must get them
    // right or a commented-out export invents a phantom name and masks a real loss.
    const names = collectExportedNames(`
      /* export const commented = 1; */
      // export const lineComment = 2;
      const template = \`export const inTemplate = 3;\`;
      export const real = 4;
    `);
    expect([...names]).toEqual(["real"]);
  });

  it("records an un-enumerable star re-export as a sentinel", () => {
    expect([...collectExportedNames('export * from "./x.js";')]).toEqual(["*"]);
  });
});

describe("collectRelativeModuleSpecifiers", () => {
  it("finds static, dynamic, re-export and type-position specifiers", () => {
    // The dynamic case is why this exists: `server-methods/sessions.js` was
    // reachable only through a lazy import(), so a regex over `from "..."`
    // reported the 2026-08-03 tree clean while the gateway could not route sessions.
    const found = collectRelativeModuleSpecifiers(`
      import { a } from "./static.js";
      export { b } from "./reexport.js";
      const c = () => import("./dynamic.js");
      type D = import("./type-position.js").D;
      import e = require("./equals.js");
      import { f } from "node:path";
      import { g } from "@openclaw/plugin-sdk";
    `);
    expect(found.map((entry) => entry.specifier)).toEqual([
      "./static.js",
      "./reexport.js",
      "./dynamic.js",
      "./type-position.js",
      "./equals.js",
    ]);
  });

  it("reports one-based lines", () => {
    const [only] = collectRelativeModuleSpecifiers('\n\nimport { a } from "./x.js";');
    expect(only?.line).toBe(3);
  });
});

describe("resolutionCandidates", () => {
  it("rewrites the ESM .js specifier onto its TypeScript source", () => {
    expect(resolutionCandidates("src/gateway/server-methods.ts", "./sessions.js")).toContain(
      "src/gateway/sessions.ts",
    );
  });

  it("normalizes parent traversal", () => {
    expect(resolutionCandidates("src/a/b/c.ts", "../../infra/agent-events.js")).toContain(
      "src/infra/agent-events.ts",
    );
  });

  it("offers directory index resolution", () => {
    expect(resolutionCandidates("src/a.ts", "./dir")).toContain("src/dir/index.ts");
  });
});

describe("findUnresolvedRelativeImports", () => {
  const files = ["src/gateway/server-methods.ts"];
  const readSource = sourcesOf({
    "src/gateway/server-methods.ts": 'const load = () => import("./server-methods/sessions.js");',
  });

  it("reports a module the merge dropped", () => {
    const findings = findUnresolvedRelativeImports({
      files,
      treePaths: new Set(files),
      inputTreePaths: new Set([...files, "src/gateway/server-methods/sessions.ts"]),
      readSource,
    });
    expect(findings).toEqual([
      {
        kind: "unresolved-import",
        file: "src/gateway/server-methods.ts",
        line: 1,
        specifier: "./server-methods/sessions.js",
      },
    ]);
  });

  it("stays quiet when the target existed on no input side", () => {
    // scripts/e2e/* import ../../dist/** build output by design, and a few stale
    // script references predate the merge. Reporting those buried the two real
    // drops under twelve non-issues.
    expect(
      findUnresolvedRelativeImports({
        files,
        treePaths: new Set(files),
        inputTreePaths: new Set(files),
        readSource,
      }),
    ).toEqual([]);
  });

  it("stays quiet when the import resolves", () => {
    expect(
      findUnresolvedRelativeImports({
        files,
        treePaths: new Set([...files, "src/gateway/server-methods/sessions.ts"]),
        inputTreePaths: new Set([...files, "src/gateway/server-methods/sessions.ts"]),
        readSource,
      }),
    ).toEqual([]);
  });
});

describe("findCountLiteralDisagreements", () => {
  const conflicted = (ours: string, theirs: string) =>
    `const a = 1;\n<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> upstream\n`;

  it("reports a hunk where the two sides carry different counts", () => {
    // check-protocol-registry.mjs on 2026-08-03: ours 55, upstream 53, merged tree
    // 56. Taking either side ships a wrong assertion.
    const findings = findCountLiteralDisagreements({
      files: ["scripts/check-protocol-registry.mjs"],
      readSource: sourcesOf({
        "scripts/check-protocol-registry.mjs": conflicted(
          "ownerModules.length === 55",
          "ownerModules.length === 53",
        ),
      }),
    });
    expect(findings).toEqual([
      {
        kind: "count-literal-disagreement",
        file: "scripts/check-protocol-registry.mjs",
        ours: "55",
        theirs: "53",
      },
    ]);
  });

  it("ignores single digits", () => {
    // Array indices, enum ordinals and `+ 1` disagree constantly and mean nothing.
    expect(
      findCountLiteralDisagreements({
        files: ["a.ts"],
        readSource: sourcesOf({ "a.ts": conflicted("items[0]", "items[1]") }),
      }),
    ).toEqual([]);
  });

  it("stays quiet when both sides agree on the numbers", () => {
    expect(
      findCountLiteralDisagreements({
        files: ["a.ts"],
        readSource: sourcesOf({
          "a.ts": conflicted("const limit = 4096; // fork", "const limit = 4096; // upstream"),
        }),
      }),
    ).toEqual([]);
  });

  it("reads diff3-style markers, ignoring the base section", () => {
    // A diff3 base section holding the OLD count must not be mistaken for a side.
    const findings = findCountLiteralDisagreements({
      files: ["a.ts"],
      readSource: sourcesOf({
        "a.ts":
          "<<<<<<< ours\nlength === 55\n||||||| base\nlength === 50\n=======\nlength === 53\n>>>>>>> upstream\n",
      }),
    });
    expect(findings).toEqual([
      { kind: "count-literal-disagreement", file: "a.ts", ours: "55", theirs: "53" },
    ]);
  });
});

describe("findForkExportDrift", () => {
  const file = "src/infra/agent-events.ts";

  const readSides = (sides: Record<"upstream" | "fork" | "merged", string | undefined>) => {
    return (side: "upstream" | "fork" | "merged") => sides[side];
  };

  it("reports a dropped fork-only export that predates the merge base", () => {
    // registerAgentRunContext sat in base AND fork, never in upstream, and the
    // merge dropped it. Mirroring the upstream gate's `- base` term filtered
    // exactly this shape out and the detector reported a clean tree over 13 lost
    // symbols, so this is the regression test for the detector itself.
    const { findings } = findForkExportDrift({
      files: [file],
      readSource: readSides({
        fork: "export function registerAgentRunContext() {}\nexport function shared() {}",
        upstream: "export function shared() {}",
        merged: "export function shared() {}",
      }),
    });
    expect(findings).toEqual([
      {
        kind: "fork-export-drift",
        file,
        symbols: ["registerAgentRunContext"],
        fileDropped: false,
      },
    ]);
  });

  it("does not report a symbol upstream also carries", () => {
    // Excluding upstream's own surface is what keeps this quiet: ordinary upstream
    // refactors and adopted upstream deletions must never fire.
    const { findings } = findForkExportDrift({
      files: [file],
      readSource: readSides({
        fork: "export function shared() {}",
        upstream: "export function shared() {}",
        merged: "",
      }),
    });
    expect(findings).toEqual([]);
  });

  it("counts a relocated symbol as moved, not lost", () => {
    // Upstream moved the whole run-context registry to infra/agent-run-registry.ts.
    // A per-file check reads every such move as fork loss.
    const { findings, relocated } = findForkExportDrift({
      files: [file],
      mergedExportIndex: new Set(["registerAgentRunContext"]),
      readSource: readSides({
        fork: "export function registerAgentRunContext() {}",
        upstream: "",
        merged: "",
      }),
    });
    expect(findings).toEqual([]);
    expect(relocated).toEqual([`${file}:registerAgentRunContext`]);
  });

  it("flags every fork export when the merge drops the file outright", () => {
    const { findings } = findForkExportDrift({
      files: [file],
      readSource: readSides({
        fork: "export const MAX_ANNOUNCE_RETRY_COUNT = 3;",
        upstream: undefined,
        merged: undefined,
      }),
    });
    expect(findings).toEqual([
      {
        kind: "fork-export-drift",
        file,
        symbols: ["MAX_ANNOUNCE_RETRY_COUNT"],
        fileDropped: true,
      },
    ]);
  });
});
