import { describe, expect, it } from "vitest";
import {
  filterApplicabilityScoped,
  scopeHolds,
  scopeTokenHolds,
  type ApplicabilityContext,
} from "./applicability-gate.js";

describe("scopeTokenHolds", () => {
  it("matches agent id case-insensitively", () => {
    const ctx: ApplicabilityContext = { agentId: "Main" };
    expect(scopeTokenHolds("main", ctx)).toBe(true);
    expect(scopeTokenHolds("MAIN", ctx)).toBe(true);
    expect(scopeTokenHolds("other-agent", ctx)).toBe(false);
  });

  it("matches scope token at word boundaries in the query text", () => {
    const ctx: ApplicabilityContext = { queryText: "duckie keeps rebooting every night" };
    expect(scopeTokenHolds("duckie", ctx)).toBe(true);
    expect(scopeTokenHolds("night", ctx)).toBe(true);
  });

  it("does not match a token embedded inside a larger word", () => {
    const ctx: ApplicabilityContext = { queryText: "duckie keeps rebooting" };
    expect(scopeTokenHolds("duck", ctx)).toBe(false);
    expect(scopeTokenHolds("uc", ctx)).toBe(false);
  });

  it("matches hyphenated tokens verbatim", () => {
    const ctx: ApplicabilityContext = { queryText: "the work-laptop is slow" };
    expect(scopeTokenHolds("work-laptop", ctx)).toBe(true);
    // "laptop" and "work" also hold — the hyphen is a word boundary, so
    // bare tokens match the compound at strict word boundaries.
    expect(scopeTokenHolds("laptop", ctx)).toBe(true);
    expect(scopeTokenHolds("work", ctx)).toBe(true);
  });

  it("does not crash or falsely match regex metacharacters in tokens", () => {
    const ctx: ApplicabilityContext = { queryText: "address 192.168.50.128 is the pi-hole" };
    expect(scopeTokenHolds("192.168.50.128", ctx)).toBe(true);
    expect(scopeTokenHolds("192.*", ctx)).toBe(false); // wildcard must stay literal
    expect(scopeTokenHolds("(duckie)", ctx)).toBe(false);
  });

  it("matches case-insensitively in query text", () => {
    const ctx: ApplicabilityContext = { queryText: "What about DUCKIE?" };
    expect(scopeTokenHolds("duckie", ctx)).toBe(true);
  });

  it("returns false when no context is available", () => {
    expect(scopeTokenHolds("duckie", {})).toBe(false);
    expect(scopeTokenHolds("duckie", { agentId: null, queryText: undefined })).toBe(false);
  });

  it("treats an empty token as unconstrained (defensive)", () => {
    expect(scopeTokenHolds("   ", { agentId: "main" })).toBe(true);
  });
});

describe("scopeHolds", () => {
  it("unscoped facts always hold", () => {
    const ctx: ApplicabilityContext = {};
    expect(scopeHolds(undefined, ctx)).toBe(true);
    expect(scopeHolds([], ctx)).toBe(true);
  });

  it("holds when ANY token holds (OR semantics)", () => {
    const ctx: ApplicabilityContext = { agentId: "main", queryText: "japan trip notes" };
    expect(scopeHolds(["huey", "japan"], ctx)).toBe(true);
    expect(scopeHolds(["huey", "duckie"], ctx)).toBe(false);
  });

  it("holds via agent id when query text is unrelated", () => {
    const ctx: ApplicabilityContext = { agentId: "main", queryText: "unrelated query" };
    expect(scopeHolds(["main", "huey"], ctx)).toBe(true);
  });
});

describe("filterApplicabilityScoped", () => {
  const results = [
    { fact: { id: "1", applicability: undefined } },
    { fact: { id: "2", applicability: ["duckie"] } },
    { fact: { id: "3", applicability: ["work-laptop", "office"] } },
    { fact: { id: "4", applicability: [] } },
  ];

  it("keeps unscoped facts and drops facts whose scope does not hold", () => {
    const kept = filterApplicabilityScoped(results, { queryText: "what about the office wifi" });
    expect(kept.map((r) => r.fact.id)).toEqual(["1", "3", "4"]);
  });

  it("keeps everything when the scope matches the query", () => {
    const kept = filterApplicabilityScoped(results, {
      queryText: "duckie and the work-laptop",
    });
    expect(kept.map((r) => r.fact.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("keeps a scoped fact when the agent id equals its scope token", () => {
    const kept = filterApplicabilityScoped(results, { agentId: "duckie", queryText: "any" });
    // Fact 2 (scope ["duckie"]) holds via the agent id; fact 3
    // (["work-laptop", "office"]) still drops — no fuzzy matching.
    expect(kept.map((r) => r.fact.id)).toEqual(["1", "2", "4"]);
  });

  it("returns a new array and preserves order", () => {
    const input = [...results];
    const kept = filterApplicabilityScoped(results, {});
    expect(kept).not.toBe(input);
    expect(input.length).toBe(4);
    expect(kept.map((r) => r.fact.id)).toEqual(["1", "4"]);
  });
});
