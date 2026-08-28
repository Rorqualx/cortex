import { describe, expect, it } from "vitest";
import { danglingReferenceStats, extractReferents } from "./dangling-metric.js";

// F8 (2026-08-28): measure-first dangling-reference metric. Linear-time
// patterns only — these tests also pin the ReDoS-safe shapes.

describe("extractReferents", () => {
  it("collects multi-word capitalized entities and acronyms", () => {
    const refs = extractReferents("Huey The Destroyer runs Transmission; QMD cache is warm");
    expect(refs.has("Huey The Destroyer")).toBe(true);
    expect(refs.has("QMD")).toBe(true);
    expect(refs.has("Transmission")).toBe(false); // single word, not an acronym
  });

  it("filters sentence-leading stopwords", () => {
    const refs = extractReferents("The operation completed. This patch failed.");
    expect(refs.has("The")).toBe(false);
    expect(refs.size).toBe(0);
  });

  it("returns empty set for empty input", () => {
    expect(extractReferents("").size).toBe(0);
  });
});

describe("danglingReferenceStats", () => {
  it("reports zero rate when all referents survive", () => {
    const stats = danglingReferenceStats(
      "Pi-hole Gateway handles DNS for Hampton Network",
      "Pi-hole Gateway keeps Hampton Network DNS",
    );
    expect(stats.rate).toBe(0);
    expect(stats.danglingCount).toBe(0);
  });

  it("flags referents that lost their anchor", () => {
    const stats = danglingReferenceStats(
      "MTU 9000 set on Huey The Destroyer; CCR store flushed",
      "MTU 9000 set; store flushed",
    );
    // MTU survives; Huey The Destroyer and CCR are dangling.
    expect(stats.dangling).toContain("CCR");
    expect(stats.dangling).toContain("Huey The Destroyer");
    expect(stats.rate).toBeGreaterThan(0);
    expect(stats.referentCount).toBe(3);
  });

  it("returns zero when there is nothing to measure", () => {
    const stats = danglingReferenceStats("", "");
    expect(stats.rate).toBe(0);
    expect(stats.referentCount).toBe(0);
  });

  it("caps the reported dangling list", () => {
    const before = Array.from({ length: 30 }, (_, i) => `Entity A${i} Module`).join("; ");
    const stats = danglingReferenceStats(before, "nothing survived");
    expect(stats.danglingCount).toBe(30);
    expect(stats.dangling.length).toBeLessThanOrEqual(20);
  });
});
