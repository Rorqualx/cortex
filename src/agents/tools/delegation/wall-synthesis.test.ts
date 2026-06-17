// Regression test for the wall-synthesis fix: when the explore loop crosses the
// synthesis-reserve deadline it must run one FORCED synthesis turn
// (toolChoice:"none") and return that content as a real answer — never the
// empty/mid-reasoning fragment that the old hard-abort produced.
//
// The mock client returns empty content + a fresh tool call every normal turn,
// and the synthesis marker only on the forced (toolChoice:"none") turn. So a
// non-empty result PROVES the forced synthesis turn ran, and the halt reason
// must be wall_cap.
import { describe, expect, it } from "vitest";
import { runExploreLoop } from "./explore-loop.js";
import type { LlmChatParams, LlmCallResult, LlmClient } from "./providers/types.js";

const SYNTH_MARKER = "FINAL_SYNTHESIS_FROM_FORCED_TURN";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeMockClient(): LlmClient {
  let turn = 0;
  return {
    provider: "zai",
    call: async (): Promise<LlmCallResult> => {
      throw new Error("call() not used in explore loop");
    },
    chat: async (params: LlmChatParams): Promise<LlmCallResult> => {
      await sleep(100);
      turn += 1;
      // The forced synthesis turn disables tools; that's the only turn that
      // emits content.
      if (params.toolChoice === "none") {
        return {
          content: SYNTH_MARKER,
          model: "mock",
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 0,
        };
      }
      // Normal turn: no content, a unique tool call (unique args avoid the
      // no-progress detector so the loop runs until the wall).
      return {
        content: "",
        model: "mock",
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 0,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: `call-${turn}`,
            function: {
              name: "list_dir",
              arguments: JSON.stringify({ path: `/tmp/does-not-exist-${turn}` }),
            },
          },
        ],
      };
    },
  };
}

describe("explore loop wall-synthesis reserve", () => {
  it("runs a forced synthesis turn on wall expiry and returns real content (not a fragment)", async () => {
    const client = makeMockClient();
    const result = await runExploreLoop(client, {
      task: "find something",
      roots: ["/tmp"],
      model: "mock",
      thinking: false,
      format: "markdown",
      maxIterations: 50,
      maxOutputTokens: 100,
      // 800ms wall → reserve caps at half (400ms); soft deadline at ~400ms,
      // hard at 800ms. The forced synthesis turn fires after the soft deadline
      // with comfortable margin before the hard wall.
      wallTimeMs: 800,
    });

    expect(result.content).toBe(SYNTH_MARKER);
    expect(result.stats.haltReason).toBe("wall_cap");
    // The loop converged to a real answer, so it is classified as a success
    // subtype's sibling — the key invariant is non-empty synthesized content.
    expect(result.content.trim().length).toBeGreaterThan(0);
  });
});
