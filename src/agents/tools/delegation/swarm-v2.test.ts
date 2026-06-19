// End-to-end coverage for runSwarmV2Loop driven by a deterministic mock
// LlmClient (same pattern as wall-synthesis.test.ts). Proves the spawn -> record
// -> synthesize round-trip, the budget cap, and — critically — that the RAII
// slot release/reacquire lets a recursive spawn run under a single permit
// without deadlocking.

import { describe, expect, it } from "vitest";
import type { LlmCallResult, LlmChatParams, LlmClient } from "./providers/types.js";
import { runSwarmV2Loop } from "./swarm-v2-loop.js";
import type { SwarmV2Input } from "./swarm-v2-types.js";

/**
 * A mock CEO/sub-agent brain: any agent that still has the spawn_subagents tool
 * and hasn't yet spawned issues exactly one spawn call with `subtasksPerSpawn`
 * children; everyone else (already spawned, or a leaf without the tool) emits a
 * final synthesis. "already spawned" is read from this agent's own message
 * history, so it works uniformly for the CEO and every sub-agent.
 */
function makeSwarmMock(subtasksPerSpawn: number): LlmClient {
  let calls = 0;
  return {
    provider: "zai",
    call: async (): Promise<LlmCallResult> => {
      throw new Error("call() not used in the swarm loop");
    },
    chat: async (params: LlmChatParams): Promise<LlmCallResult> => {
      calls += 1;
      const hasSpawn = (params.tools ?? []).some((t) => t.function.name === "spawn_subagents");
      const alreadySpawned = params.messages.some(
        (m) =>
          m.role === "assistant" &&
          (m.tool_calls ?? []).some((tc) => tc.function.name === "spawn_subagents"),
      );
      if (hasSpawn && !alreadySpawned && params.toolChoice !== "none") {
        const subtasks = Array.from({ length: subtasksPerSpawn }, (_, i) => ({
          objective: `enumerate slice number ${i} of the target thoroughly`,
          allowed_tools: ["read_file"],
          thinking: false,
        }));
        return {
          content: "",
          model: "mock",
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 0,
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `spawn-${calls}`,
              function: { name: "spawn_subagents", arguments: JSON.stringify({ subtasks }) },
            },
          ],
        };
      }
      return {
        content: "FINAL ANSWER",
        model: "mock",
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 0,
        finishReason: "stop",
      };
    },
  };
}

function finalAnswer(): LlmCallResult {
  return {
    content: "FINAL ANSWER",
    model: "mock",
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 0,
    finishReason: "stop",
  };
}

function toolCall(name: string, args: unknown, id: string): LlmCallResult {
  return {
    content: "",
    model: "mock",
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 0,
    finishReason: "tool_calls",
    toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
  };
}

/**
 * A CEO that does the full pipeline — spawn one worker, then verify two claims,
 * then synthesize — plus the skeptic brains. Skeptics vote by claim text: a
 * claim containing "REFUTE-ME" gets REFUTED, everything else SUPPORTED. Phase is
 * read from message history (which tool calls this agent already issued), so it
 * works without per-agent state. verify_claims is CEO-only, so the presence of
 * that tool distinguishes the CEO from leaf workers.
 */
function makeVerifyingMock(): LlmClient {
  return {
    provider: "zai",
    call: async (): Promise<LlmCallResult> => {
      throw new Error("call() not used in the swarm loop");
    },
    chat: async (params: LlmChatParams): Promise<LlmCallResult> => {
      const toolNames = (params.tools ?? []).map((t) => t.function.name);
      const lastUser = [...params.messages].reverse().find((m) => m.role === "user");
      const userText = typeof lastUser?.content === "string" ? lastUser.content : "";

      if (userText.includes("Adversarially verify")) {
        const verdict = userText.includes("REFUTE-ME") ? "REFUTED" : "SUPPORTED";
        return {
          content: `judged the claim.\nVERDICT: ${verdict}`,
          model: "mock",
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 0,
          finishReason: "stop",
        };
      }

      if (toolNames.includes("verify_claims")) {
        // This is the CEO. Drive it through its phases.
        const issued = (name: string) =>
          params.messages.some(
            (m) =>
              m.role === "assistant" &&
              (m.tool_calls ?? []).some((tc) => tc.function.name === name),
          );
        if (!issued("spawn_subagents")) {
          return toolCall(
            "spawn_subagents",
            {
              subtasks: [
                {
                  objective: "enumerate the relevant findings",
                  allowed_tools: ["read_file"],
                  thinking: false,
                },
              ],
            },
            "spawn-1",
          );
        }
        if (!issued("verify_claims")) {
          return toolCall(
            "verify_claims",
            {
              claims: [
                { claim: "finding one REFUTE-ME does not actually hold" },
                { claim: "finding two is solid and well supported" },
              ],
            },
            "verify-1",
          );
        }
        return finalAnswer();
      }

      // Leaf worker.
      return finalAnswer();
    },
  };
}

function baseInput(overrides: Partial<SwarmV2Input> = {}): SwarmV2Input {
  return {
    task: "audit the entire codebase for the invariant",
    roots: [process.cwd()],
    model: "mock",
    thinking: false,
    format: "markdown",
    maxOutputTokens: 1000,
    wallTimeMs: 60_000,
    maxOrchestrationRounds: 6,
    ...overrides,
  };
}

describe("runSwarmV2Loop", () => {
  it("happy path: CEO spawns leaves, records the tree, and stops cleanly", async () => {
    const res = await runSwarmV2Loop(makeSwarmMock(2), baseInput({ maxDepth: 1 }));
    expect(res.haltReason).toBe("stop");
    expect(res.content).toBe("FINAL ANSWER");
    expect(res.stats.totalAgents).toBe(3); // CEO + 2 leaves
    expect(res.stats.okAgents).toBe(3);
    expect(res.stats.maxDepthReached).toBe(1);
    expect(res.stats.flatAgents[0]?.depth).toBe(0); // CEO at index 0
  });

  it("caps the tree at the spawn budget and drops the overflow", async () => {
    // capacity 1 sub-agent, but the CEO asks for 3 in one call.
    const res = await runSwarmV2Loop(
      makeSwarmMock(3),
      baseInput({ maxDepth: 1, maxTotalSubagents: 2 }),
    );
    expect(res.stats.totalAgents).toBe(2); // CEO + 1 (the other 2 dropped)
    expect(res.stats.okAgents).toBe(2);
  });

  it(
    "RAII: a recursive spawn runs under a single permit without deadlocking",
    { timeout: 10_000 },
    async () => {
      // concurrency=1 means a depth-1 agent holds the only permit. Its child can
      // only acquire if the parent released first (release-during-spawn). If the
      // RAII hooks regress, this test hangs and the timeout fails it.
      const res = await runSwarmV2Loop(
        makeSwarmMock(1),
        baseInput({ maxDepth: 2, subagentConcurrency: 1 }),
      );
      expect(res.haltReason).toBe("stop");
      expect(res.stats.totalAgents).toBe(3); // CEO + depth-1 + depth-2
      expect(res.stats.maxDepthReached).toBe(2);
      expect(res.stats.okAgents).toBe(3);
    },
  );

  it("runs the adversarial verification layer: refutes one claim, keeps the other", async () => {
    const res = await runSwarmV2Loop(makeVerifyingMock(), baseInput({ maxDepth: 1 }));
    expect(res.haltReason).toBe("stop");
    expect(res.content).toBe("FINAL ANSWER");
    // 2 claims × 3 default skeptics = 6 verifier agents in the tree.
    expect(res.stats.flatAgents.filter((a) => a.kind === "verifier")).toHaveLength(6);
    expect(res.stats.verification).toEqual({
      claims: 2,
      survived: 1,
      refuted: 1,
      verifierAgents: 6,
    });
  });
});
