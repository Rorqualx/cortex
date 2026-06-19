// Unit coverage for the adversarial verification layer: the pure verdict parse
// and majority-refute tally, plus the handler's budget-exhaustion behavior
// driven by a mock LlmClient.

import { describe, expect, it } from "vitest";
import type { LlmCallResult, LlmClient } from "./providers/types.js";
import { makeSharedState } from "./swarm-v2-state.js";
import type { SwarmV2Input } from "./swarm-v2-types.js";
import { makeVerifyClaimsTool, parseVerdict, tallyClaim } from "./swarm-v2-verify.js";

describe("parseVerdict (fail-closed)", () => {
  it("reads an explicit SUPPORTED verdict", () => {
    expect(parseVerdict("reasoning...\nVERDICT: SUPPORTED")).toBe("supported");
    expect(parseVerdict("VERDICT: supported")).toBe("supported");
  });

  it("treats REFUTED, UNCERTAIN, missing, and empty as refuted", () => {
    expect(parseVerdict("VERDICT: REFUTED")).toBe("refuted");
    expect(parseVerdict("VERDICT: UNCERTAIN")).toBe("refuted");
    expect(parseVerdict("I think it's probably fine but not sure")).toBe("refuted");
    expect(parseVerdict("")).toBe("refuted");
  });

  it("uses the LAST verdict token when the model restates", () => {
    expect(parseVerdict("VERDICT: SUPPORTED\n...actually no...\nVERDICT: REFUTED")).toBe("refuted");
  });
});

describe("tallyClaim (majority-refute)", () => {
  const refuted = (n: number) => Array(n).fill("refuted" as const);
  const supported = (n: number) => Array(n).fill("supported" as const);

  it("K=3 survives at 0 or 1 refutes, dies at 2 or 3", () => {
    expect(tallyClaim([...supported(3)]).survived).toBe(true);
    expect(tallyClaim([...refuted(1), ...supported(2)]).survived).toBe(true);
    expect(tallyClaim([...refuted(2), ...supported(1)]).survived).toBe(false);
    expect(tallyClaim([...refuted(3)]).survived).toBe(false);
  });

  it("K=5 needs 3 refutes to die", () => {
    expect(tallyClaim([...refuted(2), ...supported(3)]).survived).toBe(true);
    expect(tallyClaim([...refuted(3), ...supported(2)]).survived).toBe(false);
  });

  it("fails closed on a tie (even skeptic count from partial budget)", () => {
    expect(tallyClaim([...refuted(1), ...supported(1)]).survived).toBe(false);
    expect(tallyClaim([...refuted(2), ...supported(2)]).survived).toBe(false);
    // a lone skeptic still decides: support survives, refute kills
    expect(tallyClaim([...supported(1)]).survived).toBe(true);
    expect(tallyClaim([...refuted(1)]).survived).toBe(false);
  });

  it("reports the vote split", () => {
    const t = tallyClaim([...refuted(2), ...supported(1)]);
    expect(t).toMatchObject({ refutedVotes: 2, supportedVotes: 1, survived: false });
  });
});

function baseInput(): SwarmV2Input {
  return {
    task: "audit the codebase",
    roots: [process.cwd()],
    model: "mock",
    thinking: false,
    format: "markdown",
    maxOutputTokens: 1000,
    wallTimeMs: 60_000,
  };
}

// A verifier brain that always votes SUPPORTED (so any claim that gets skeptics
// survives) — lets us isolate the budget-drop path.
function supportingClient(): LlmClient {
  return {
    provider: "zai",
    call: async (): Promise<LlmCallResult> => {
      throw new Error("call() not used");
    },
    chat: async (): Promise<LlmCallResult> => ({
      content: "checked the source, it holds.\nVERDICT: SUPPORTED",
      model: "mock",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 0,
      finishReason: "stop",
    }),
  };
}

describe("verify_claims handler budget", () => {
  it("verifies what fits and marks the rest UNVERIFIED when the budget runs out", async () => {
    // capacity 3 sub-agent slots; ask for 2 claims × 3 skeptics = 6 → only the
    // first 3 reservations succeed (all on claim 0), claim 1 gets none.
    const state = makeSharedState({
      provider: "zai",
      wallMs: 60_000,
      maxTotalSubagents: 4, // CEO(0) + 3 slots
      maxDepth: 3,
    });
    const tool = makeVerifyClaimsTool(0, 0, baseInput(), supportingClient(), state, []);
    const res = await tool.handler(
      {
        claims: [
          { claim: "claim alpha is true and load-bearing" },
          { claim: "claim beta is also load-bearing here" },
        ],
        verifiers_per_claim: 3,
      },
      { signal: new AbortController().signal, iteration: 1, remainingWallMs: 60_000 },
    );

    expect(res.content).toContain("UNVERIFIED");
    expect(res.meta).toMatchObject({ verifiedClaims: 1, survived: 1, unverified: 1 });
    // Exactly the 3 reservable verifiers ran; the cap was never exceeded.
    expect(state.subagentCount()).toBe(3);
    expect(state.flatAgents.filter((a) => a.kind === "verifier")).toHaveLength(3);
  });

  it("skips entirely (no verifiers spawned) when the wall already fired", async () => {
    const state = makeSharedState({
      provider: "zai",
      wallMs: 60_000,
      maxTotalSubagents: 10,
      maxDepth: 3,
    });
    state.wallController.abort();
    const tool = makeVerifyClaimsTool(0, 0, baseInput(), supportingClient(), state, []);
    const res = await tool.handler(
      { claims: [{ claim: "some load-bearing claim to verify here" }] },
      { signal: new AbortController().signal, iteration: 1, remainingWallMs: 0 },
    );
    expect(res.meta).toMatchObject({ error: "wall_aborted" });
    expect(state.flatAgents.filter((a) => a.kind === "verifier")).toHaveLength(0);
    expect(state.verifiedClaims).toBe(0);
  });
});
