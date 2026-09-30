// Covers JSON merge-patch behavior for config mutations.
import { describe, expect, it } from "vitest";
import { applyMergePatch, createMergePatch } from "./merge-patch.js";

const agentListBase = {
  agents: {
    list: [
      { id: "primary", workspace: "/tmp/one" },
      { id: "secondary", workspace: "/tmp/two" },
    ],
  },
};
const agentListPatch = {
  agents: {
    list: [{ id: "primary", memory: { search: { extraPaths: ["/tmp/memory.md"] } } }],
  },
};

describe("applyMergePatch", () => {
  it("replaces arrays by default", () => {
    expect(applyMergePatch(agentListBase, agentListPatch)).toEqual({
      agents: {
        list: [{ id: "primary", memory: { search: { extraPaths: ["/tmp/memory.md"] } } }],
      },
    });
  });

  it("merges object arrays by id when enabled", () => {
    expect(applyMergePatch(agentListBase, agentListPatch, { mergeObjectArraysById: true })).toEqual(
      {
        agents: {
          list: [
            {
              id: "primary",
              workspace: "/tmp/one",
              memory: { search: { extraPaths: ["/tmp/memory.md"] } },
            },
            { id: "secondary", workspace: "/tmp/two" },
          ],
        },
      },
    );
  });

  it("replaces object arrays by id when the array path is explicit", () => {
    expect(
      applyMergePatch(agentListBase, agentListPatch, {
        mergeObjectArraysById: true,
        replaceArrayPaths: new Set(["agents.list"]),
      }),
    ).toEqual({
      agents: {
        list: [{ id: "primary", memory: { search: { extraPaths: ["/tmp/memory.md"] } } }],
      },
    });
  });

  it("replaces nested arrays in id-keyed entries when the nested path is explicit", () => {
    const base = {
      agents: {
        list: [
          { id: "primary", skills: ["a", "b"] },
          { id: "secondary", skills: ["c"] },
        ],
      },
    };
    const patch = { agents: { list: [{ id: "primary", skills: ["a"] }] } };
    expect(
      applyMergePatch(base, patch, {
        mergeObjectArraysById: true,
        replaceArrayPaths: new Set(["agents.list[].skills"]),
      }),
    ).toEqual({
      agents: {
        list: [
          { id: "primary", skills: ["a"] },
          { id: "secondary", skills: ["c"] },
        ],
      },
    });
  });

  it("merges by id even when patch entries lack id (appends them)", () => {
    const patch = {
      agents: { list: [{ id: "primary", model: "new-model" }, { workspace: "/tmp/orphan" }] },
    };
    expect(applyMergePatch(agentListBase, patch, { mergeObjectArraysById: true })).toEqual({
      agents: {
        list: [
          { id: "primary", workspace: "/tmp/one", model: "new-model" },
          { id: "secondary", workspace: "/tmp/two" },
          { workspace: "/tmp/orphan" },
        ],
      },
    });
  });

  it("keeps existing id entries when patch mixes id and primitive entries", () => {
    const patch = {
      agents: {
        list: [{ id: "primary", workspace: "/tmp/one-updated" }, "non-object entry"],
      },
    };
    expect(applyMergePatch(agentListBase, patch, { mergeObjectArraysById: true })).toEqual({
      agents: {
        list: [
          { id: "primary", workspace: "/tmp/one-updated" },
          { id: "secondary", workspace: "/tmp/two" },
          "non-object entry",
        ],
      },
    });
  });

  it("falls back to replacement for non-id arrays even when enabled", () => {
    const base = { channels: { telegram: { allowFrom: ["111", "222"] } } };
    const patch = { channels: { telegram: { allowFrom: ["333"] } } };
    expect(applyMergePatch(base, patch, { mergeObjectArraysById: true })).toEqual({
      channels: { telegram: { allowFrom: ["333"] } },
    });
  });
});

// createMergePatch decides "did this value change" with a hand-rolled structural
// walk (node:util's isDeepStrictEqual cannot be imported here — the Control UI
// bundles this module and Vite externalizes node builtins). Pin the semantics
// that swap depended on; a looser comparison silently drops real config edits.
describe("createMergePatch value equality", () => {
  it("omits unchanged nested arrays and objects", () => {
    const base = { a: [1, 2, { b: "x" }], c: { d: [true, null] } };
    const target = { a: [1, 2, { b: "x" }], c: { d: [true, null] } };
    expect(createMergePatch(base, target)).toEqual({});
  });

  it("detects array order and length changes", () => {
    expect(createMergePatch({ a: [1, 2] }, { a: [2, 1] })).toEqual({ a: [2, 1] });
    expect(createMergePatch({ a: [1, 2] }, { a: [1, 2, 3] })).toEqual({ a: [1, 2, 3] });
  });

  it("detects an added or removed key at equal key counts", () => {
    expect(createMergePatch({ a: { x: 1, y: 2 } }, { a: { x: 1, z: 2 } })).toEqual({
      a: { y: null, z: 2 },
    });
  });

  it("treats NaN as unchanged and -0 as a change, matching isDeepStrictEqual", () => {
    expect(createMergePatch({ a: Number.NaN }, { a: Number.NaN })).toEqual({});
    expect(createMergePatch({ a: 0 }, { a: -0 })).toEqual({ a: -0 });
  });

  it("distinguishes null from a missing value", () => {
    expect(createMergePatch({ a: null }, { a: undefined })).toEqual({ a: undefined });
  });
});
