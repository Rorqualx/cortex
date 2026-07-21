import { describe, expect, it } from "vitest";
import { dedupWithinChunk, dropAlreadyKnown, liftToL2Fact } from "./dedup.js";

describe("dedupWithinChunk", () => {
  it("returns the input when all dedupKeys are unique", () => {
    const facts = [
      { text: "a", importance: 0.5, dedupKey: "k:1" },
      { text: "b", importance: 0.5, dedupKey: "k:2" },
    ];
    expect(dedupWithinChunk(facts)).toEqual(facts);
  });

  it("drops later facts with a colliding dedupKey", () => {
    const facts = [
      { text: "first", importance: 0.8, dedupKey: "k:1" },
      { text: "later", importance: 0.3, dedupKey: "k:1" },
    ];
    const result = dedupWithinChunk(facts);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("first");
    expect(result[0]!.importance).toBe(0.8);
  });

  it("preserves order across distinct dedupKeys", () => {
    const facts = [
      { text: "a", importance: 0.5, dedupKey: "k:1" },
      { text: "b", importance: 0.5, dedupKey: "k:2" },
      { text: "a-dup", importance: 0.5, dedupKey: "k:1" },
      { text: "c", importance: 0.5, dedupKey: "k:3" },
    ];
    const result = dedupWithinChunk(facts);
    expect(result.map((f) => f.dedupKey)).toEqual(["k:1", "k:2", "k:3"]);
  });

  it("returns [] for empty input", () => {
    expect(dedupWithinChunk([])).toEqual([]);
  });
});

describe("dropAlreadyKnown", () => {
  it("removes facts whose dedupKey is in the known set", () => {
    const facts = [
      { text: "a", importance: 0.5, dedupKey: "k:1" },
      { text: "b", importance: 0.5, dedupKey: "k:2" },
    ];
    const known = new Set(["k:1"]);
    const result = dropAlreadyKnown(facts, known);
    expect(result).toHaveLength(1);
    expect(result[0]!.dedupKey).toBe("k:2");
  });

  it("returns input unchanged when known set is empty", () => {
    const facts = [{ text: "a", importance: 0.5, dedupKey: "k:1" }];
    expect(dropAlreadyKnown(facts, new Set())).toEqual(facts);
  });
});

describe("liftToL2Fact", () => {
  it("attaches a unique id and createdAt timestamp", () => {
    const a = liftToL2Fact({ text: "hi", importance: 0.5, dedupKey: "k:1" }, 1700);
    const b = liftToL2Fact({ text: "hi", importance: 0.5, dedupKey: "k:2" }, 1700);
    expect(a.id).not.toBe(b.id);
    expect(a.createdAt).toBe(1700);
    expect(a.text).toBe("hi");
    expect(a.dedupKey).toBe("k:1");
  });

  it("auto-marks failure: dedupKeys as significant", () => {
    const fact = liftToL2Fact(
      {
        text: "doom loop from repeated grep",
        importance: 0.7,
        dedupKey: "failure:doom_loop_pattern",
      },
      1700,
    );
    expect(fact.significant).toBe(true);
  });

  it("does not mark non-failure dedupKeys as significant", () => {
    const fact = liftToL2Fact(
      { text: "user likes tea", importance: 0.5, dedupKey: "user_preference:tea" },
      1700,
    );
    expect(fact.significant).toBeFalsy();
  });
});
