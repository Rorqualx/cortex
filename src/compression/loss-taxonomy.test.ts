import { describe, expect, it } from "vitest";
import {
  hasEntityBinding,
  hasLossTaxonomyAnchor,
  hasNegation,
  hasQuantity,
} from "./loss-taxonomy.js";

// QW3 (2026-11-22, arXiv:2608.11775 loss taxonomy): deterministic counterpart
// of the memory-l3 LOSS-TAXONOMY prompt rule (PROMPT_VERSION=21). Pure
// predicate tests mirroring the hasTemporalAnchor tests in compression.test.ts.

describe("hasQuantity", () => {
  it("matches numbers with units", () => {
    expect(hasQuantity("disk is 4 TB")).toBe(true);
    expect(hasQuantity("took 250ms")).toBe(true);
    expect(hasQuantity("cost 30 dollars")).toBe(true);
    expect(hasQuantity("waited 3 weeks")).toBe(true);
    expect(hasQuantity("85% of capacity")).toBe(true);
  });

  it("rejects bare numbers without units", () => {
    expect(hasQuantity("row 12 of 40 items")).toBe(false);
    expect(hasQuantity("version 1.2.3")).toBe(false);
    expect(hasQuantity("")).toBe(false);
  });
});

describe("hasNegation", () => {
  it("matches negation markers", () => {
    expect(hasNegation("this is not enabled")).toBe(true);
    expect(hasNegation("he never replied")).toBe(true);
    expect(hasNegation("it's no longer valid")).toBe(true);
    expect(hasNegation("we don't support that")).toBe(true);
  });

  it("rejects affirmative statements", () => {
    expect(hasNegation("this is enabled")).toBe(false);
    expect(hasNegation("always reply promptly")).toBe(false);
  });
});

describe("hasEntityBinding", () => {
  it("matches proper-noun possessive bindings", () => {
    expect(hasEntityBinding("Huey's disk")).toBe(true);
    expect(hasEntityBinding("Maria's laptop crashed")).toBe(true);
  });

  it("rejects generic possessives and lowercase subjects", () => {
    expect(hasEntityBinding("the disk's size")).toBe(false);
    expect(hasEntityBinding("a server")).toBe(false);
  });
});

describe("hasLossTaxonomyAnchor", () => {
  it("fires on any of the three loss classes", () => {
    expect(hasLossTaxonomyAnchor("Huey's disk")).toBe(true);
    expect(hasLossTaxonomyAnchor("4 TB total")).toBe(true);
    expect(hasLossTaxonomyAnchor("never again")).toBe(true);
  });

  it("stays quiet on plain text", () => {
    expect(hasLossTaxonomyAnchor("the build finished successfully")).toBe(false);
    expect(hasLossTaxonomyAnchor("")).toBe(false);
  });
});
