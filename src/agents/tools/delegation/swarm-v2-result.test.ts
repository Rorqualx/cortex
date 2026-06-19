// Unit coverage for the pure result helpers extracted from swarm-v2-loop:
// deriveAgentOk (the single ok/empty-content contract) and adjudicateHalt (the
// final halt-reason precedence + fallback selection). These ran untested while
// they lived inline as an if/else ladder.

import { describe, expect, it } from "vitest";
import type { ExploreResult, ExploreStats } from "./explore-loop.js";
import { adjudicateHalt, deriveAgentOk, fallbackSynthesisV2 } from "./swarm-v2-result.js";
import type { SubagentV2Result } from "./swarm-v2-types.js";

function makeStats(overrides: Partial<ExploreStats> = {}): ExploreStats {
  return {
    provider: "zai",
    iterations: 1,
    toolCalls: 0,
    totalToolBytes: 0,
    compactedToolResults: 0,
    latencyMs: 0,
    modelLatencyMs: 0,
    toolLatencyMs: 0,
    toolBreakdown: [],
    model: "mock",
    inputTokens: 0,
    outputTokens: 0,
    haltReason: "stop",
    subtype: "success",
    ...overrides,
  };
}

function makeSub(overrides: Partial<SubagentV2Result> = {}): SubagentV2Result {
  return {
    index: 1,
    parentIndex: 0,
    depth: 1,
    kind: "worker",
    ok: true,
    objective: "enumerate every widget in the registry",
    allowedTools: ["read_file"],
    thinking: false,
    iterations: 2,
    toolCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 1200,
    content: "sub findings",
    childIndices: [],
    ...overrides,
  };
}

function ceo(
  content: string,
  halt: ExploreStats["haltReason"] = "stop",
  subtype: ExploreStats["subtype"] = "success",
): ExploreResult {
  return { content, stats: makeStats({ haltReason: halt, subtype }) };
}

describe("deriveAgentOk", () => {
  it("ok when subtype=success and content is non-empty", () => {
    expect(deriveAgentOk(makeStats(), "real answer")).toEqual({ ok: true });
  });

  it("not-ok with a runaway reason when subtype=success but content is empty", () => {
    const r = deriveAgentOk(makeStats({ outputTokens: 4096 }), "   ");
    expect(r.ok).toBe(false);
    expect(r.errorReason).toContain("empty content");
    expect(r.errorReason).toContain("4096");
  });

  it("not-ok with subtype+halt reason when the loop did not succeed", () => {
    const r = deriveAgentOk(
      makeStats({ subtype: "error_max_turns", haltReason: "iter_cap" }),
      "partial",
    );
    expect(r.ok).toBe(false);
    expect(r.errorReason).toBe("subtype=error_max_turns halt=iter_cap");
  });
});

describe("adjudicateHalt precedence", () => {
  const base = {
    task: "audit the codebase",
    runError: null,
    wallAborted: false,
    spawnedCount: 3,
    maxTotalSubagents: 100,
  };

  it("error when the CEO loop never returned", () => {
    const r = adjudicateHalt({
      ...base,
      ceoResult: null,
      runError: "boom",
      flatAgents: [makeSub()],
    });
    expect(r.haltReason).toBe("error");
    expect(r.content).toContain("boom");
  });

  it("ceo_synthesis_empty falls back to verbatim sub-agent output", () => {
    const r = adjudicateHalt({
      ...base,
      ceoResult: ceo(""),
      flatAgents: [makeSub({ content: "VERBATIM-SUB" })],
    });
    expect(r.haltReason).toBe("ceo_synthesis_empty");
    expect(r.content).toContain("VERBATIM-SUB");
  });

  it("hard wall abort with ok sub-agents emits fallback + CEO partial notes", () => {
    const r = adjudicateHalt({
      ...base,
      wallAborted: true,
      ceoResult: ceo("CEO-PARTIAL"),
      flatAgents: [makeSub({ content: "VERBATIM-SUB" })],
    });
    expect(r.haltReason).toBe("wall_cap");
    expect(r.content).toContain("VERBATIM-SUB");
    expect(r.content).toContain("CEO partial notes");
    expect(r.content).toContain("CEO-PARTIAL");
  });

  it("hard wall abort with no ok sub-agents returns the CEO content as-is", () => {
    const r = adjudicateHalt({
      ...base,
      wallAborted: true,
      ceoResult: ceo("CEO-ONLY"),
      flatAgents: [makeSub({ ok: false, error: "x" })],
    });
    expect(r.haltReason).toBe("wall_cap");
    expect(r.content).toBe("CEO-ONLY");
  });

  it("soft wall_cap (CEO halt, no abort) trusts the CEO synthesis", () => {
    const r = adjudicateHalt({
      ...base,
      ceoResult: ceo("SOFT-WALL-ANSWER", "wall_cap"),
      flatAgents: [makeSub()],
    });
    expect(r.haltReason).toBe("wall_cap");
    expect(r.content).toBe("SOFT-WALL-ANSWER");
  });

  it("maps CEO iter_cap and no_progress halts", () => {
    expect(
      adjudicateHalt({ ...base, ceoResult: ceo("a", "iter_cap"), flatAgents: [makeSub()] })
        .haltReason,
    ).toBe("ceo_iter_cap");
    expect(
      adjudicateHalt({ ...base, ceoResult: ceo("a", "no_progress"), flatAgents: [makeSub()] })
        .haltReason,
    ).toBe("ceo_no_progress");
  });

  it("spawn_budget_exhausted when at the cap and every sub-agent failed", () => {
    const r = adjudicateHalt({
      ...base,
      spawnedCount: 3,
      maxTotalSubagents: 3, // capacity 2; spawnedCount 3 > 2 => exhausted
      ceoResult: ceo("ceo synth"),
      flatAgents: [makeSub({ ok: false, error: "f1" }), makeSub({ index: 2, ok: false, error: "f2" })],
    });
    expect(r.haltReason).toBe("spawn_budget_exhausted");
    expect(r.content).toContain("fallback synthesis");
  });

  it("all_subagents_failed when all failed but budget was not exhausted", () => {
    const r = adjudicateHalt({
      ...base,
      spawnedCount: 2,
      maxTotalSubagents: 100,
      ceoResult: ceo("CEO-FS-WORK"),
      flatAgents: [makeSub({ ok: false, error: "f1" })],
    });
    expect(r.haltReason).toBe("all_subagents_failed");
    expect(r.content).toContain("all 1 sub-agents failed");
    expect(r.content).toContain("CEO-FS-WORK");
  });

  it("stop on the happy path returns the CEO synthesis", () => {
    const r = adjudicateHalt({
      ...base,
      ceoResult: ceo("THE ANSWER"),
      flatAgents: [makeSub(), makeSub({ index: 2 })],
    });
    expect(r.haltReason).toBe("stop");
    expect(r.content).toBe("THE ANSWER");
  });

  it("ignores failed verifier records when judging worker failure", () => {
    const r = adjudicateHalt({
      ...base,
      ceoResult: ceo("THE ANSWER"),
      flatAgents: [
        makeSub({ index: 1, kind: "worker", ok: true }),
        makeSub({ index: 2, kind: "verifier", ok: false, error: "refuted" }),
      ],
    });
    expect(r.haltReason).toBe("stop"); // a refuted claim is not a swarm failure
  });

  it("a successful verifier does not mask all-workers-failed", () => {
    const r = adjudicateHalt({
      ...base,
      spawnedCount: 2,
      maxTotalSubagents: 100,
      ceoResult: ceo("CEO-FS-WORK"),
      flatAgents: [
        makeSub({ index: 1, kind: "worker", ok: false, error: "f" }),
        makeSub({ index: 2, kind: "verifier", ok: true }),
      ],
    });
    expect(r.haltReason).toBe("all_subagents_failed");
  });
});

describe("fallbackSynthesisV2", () => {
  it("notes when no sub-agents were spawned and echoes the task", () => {
    const out = fallbackSynthesisV2("MY-TASK", [], "nothing landed");
    expect(out).toContain("no sub-agents were spawned");
    expect(out).toContain("MY-TASK");
  });

  it("emits ok content verbatim and lists failures", () => {
    const out = fallbackSynthesisV2(
      "task",
      [
        makeSub({ index: 1, ok: true, content: "OK-CONTENT" }),
        makeSub({ index: 2, ok: false, error: "exploded" }),
      ],
      "wall hit",
    );
    expect(out).toContain("1 ok, 1 failed");
    expect(out).toContain("OK-CONTENT");
    expect(out).toContain("Failed sub-agents");
    expect(out).toContain("exploded");
  });
});
