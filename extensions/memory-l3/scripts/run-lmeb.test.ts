import { describe, expect, it } from "vitest";
import {
  buildProbeQuery,
  cosineSim,
  hashEmbed,
  parseProviderSpec,
  rankMetrics,
  tokenizeText,
} from "./run-lmeb.mjs";

// LMEB embedding-provider gate (QW4, 2026-10-02): hold-out self-retrieval
// probes over the long-horizon memory corpus, scored per candidate embedding
// provider. These unit tests cover the pure helpers (probe construction,
// offline hashing lane, ranking metrics) — the network lane is exercised by
// running the script itself.

describe("tokenizeText", () => {
  it("lowercases, strips punctuation, and drops stopwords and singles", () => {
    // "The"/"is"/"at" are stopwords; "s" is a single char; punctuation splits
    // the IP into numeric tokens — acceptable for a bag-of-words baseline.
    expect(tokenizeText("The Pi-hole's DNS is at 192.168.50.128!")).toEqual([
      "pi-hole",
      "dns",
      "192",
      "168",
      "50",
      "128",
    ]);
  });

  it("handles nullish input", () => {
    expect(tokenizeText(undefined)).toEqual([]);
  });
});

describe("buildProbeQuery", () => {
  it("builds a deterministic query from the most frequent distinctive terms", () => {
    const doc = "docker compose maps ports. docker compose maps volumes. docker restarts.";
    expect(buildProbeQuery(doc, 3)).toBe("docker compose maps");
    expect(buildProbeQuery(doc, 3)).toBe(buildProbeQuery(doc, 3));
  });

  it("caps term count and returns empty for stopword-only text", () => {
    expect(buildProbeQuery("a an the of to", 6)).toBe("");
    const doc = Array.from({ length: 10 }, (_, i) => `topic${i}`).join(" ");
    expect(buildProbeQuery(doc, 4).split(" ")).toHaveLength(4);
  });
});

describe("hashEmbed + cosineSim", () => {
  it("embeds identical texts identically and gives them cosine 1", () => {
    const a = hashEmbed("docker compose port mapping", 64);
    const b = hashEmbed("docker compose port mapping", 64);
    expect(a).toEqual(b);
    expect(cosineSim(a, b)).toBeCloseTo(1, 5);
  });

  it("gives disjoint vocabularies near-zero similarity", () => {
    const a = hashEmbed("docker compose port mapping", 64);
    const b = hashEmbed("greenhouse thermal mass wall", 64);
    expect(Math.abs(cosineSim(a, b))).toBeLessThan(0.35);
  });

  it("produces unit-norm vectors for any non-empty text", () => {
    const a = hashEmbed("some text with several tokens", 32);
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("returns a zero vector rather than throwing on empty text", () => {
    expect(hashEmbed("", 8)).toEqual(new Array(8).fill(0));
    expect(cosineSim(hashEmbed("", 8), hashEmbed("x y z", 8))).toBe(0);
  });
});

describe("rankMetrics", () => {
  it("scores rank 1 as full credit", () => {
    expect(rankMetrics(1, 5)).toEqual({ recallAt1: 1, recallAtK: 1, reciprocalRank: 1 });
  });

  it("scores in-top-k hits and misses", () => {
    expect(rankMetrics(3, 5)).toEqual({ recallAt1: 0, recallAtK: 1, reciprocalRank: 1 / 3 });
    expect(rankMetrics(6, 5)).toEqual({ recallAt1: 0, recallAtK: 0, reciprocalRank: 1 / 6 });
    expect(rankMetrics(0, 5)).toEqual({ recallAt1: 0, recallAtK: 0, reciprocalRank: 0 });
  });
});

describe("parseProviderSpec", () => {
  it("parses hash and openai-compatible specs", () => {
    expect(parseProviderSpec("hash:256")).toEqual({ kind: "hash", model: "256" });
    expect(parseProviderSpec("openai-compatible:text-embedding-3-small")).toEqual({
      kind: "openai-compatible",
      model: "text-embedding-3-small",
    });
  });

  it("rejects malformed or unknown specs", () => {
    expect(() => parseProviderSpec("hashonly")).toThrow(/expected kind:model/);
    expect(() => parseProviderSpec("weird:thing")).toThrow(/Unknown provider kind/);
  });
});
