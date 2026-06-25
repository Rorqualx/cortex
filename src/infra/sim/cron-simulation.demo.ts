/**
 * Integration demonstration: simulated agent turn with scripted model provider.
 *
 * This shows how the Phase 3 scripted model provider integrates with the
 * llm-runtime to enable deterministic simulation of a single agent turn.
 *
 * Usage (not run automatically — meant as documentation and manual verification):
 *   npx vitest run src/infra/sim/cron-simulation.demo.ts --config test/vitest/vitest.infra.config.ts
 */
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  registerApiProvider,
  unregisterApiProviders,
} from "../../../packages/llm-runtime/src/api-registry.js";
import { completeSimple } from "../../../packages/llm-runtime/src/stream.js";
import { createModelRecorder, createModelReplayer, recordThenReplay } from "./record-replay.js";
import { createDeterministicSimulationEnv, withSimulationEnvAsync } from "./simulation-env.js";

const DEMO_SOURCE_ID = "demo:cron-simulation";

const demoModel = {
  id: "gpt-4",
  name: "GPT-4",
  api: "openai-completions" as const,
  provider: "openai",
  baseUrl: "https://api.openai.invalid",
  input: ["text"] as const,
  reasoning: false,
  contextWindow: 8192,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model;

describe("DST integration demo", () => {
  it("simulates a single agent turn deterministically", async () => {
    // Step 1: Set up a deterministic environment (Phase 1 building block)
    const simEnv = createDeterministicSimulationEnv({
      seed: "demo-seed-42",
      startTimeMs: 1_700_000_000_000,
    });

    // Step 2: Register a mock provider that the recorder will wrap
    const finalMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "I'll help you with that task." }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4",
      usage: {
        input: 10,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 17,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: simEnv.now(),
    };

    registerApiProvider(
      {
        api: "openai-completions",
        stream: () => {
          const s = createAssistantMessageEventStream();
          queueMicrotask(() => {
            s.push({ type: "start", partial: finalMessage });
            s.push({ type: "done", reason: "stop", message: finalMessage });
          });
          return s;
        },
        streamSimple: () => {
          const s = createAssistantMessageEventStream();
          queueMicrotask(() => {
            s.push({ type: "start", partial: finalMessage });
            s.push({ type: "done", reason: "stop", message: finalMessage });
          });
          return s;
        },
      },
      DEMO_SOURCE_ID,
    );

    // Step 3: Record a turn
    const recordScripts = new Map();
    const recorder = createModelRecorder({ scripts: recordScripts });

    const recordedResult = await withSimulationEnvAsync(simEnv, () =>
      recorder.run(async () => {
        const result = await completeSimple(demoModel, {
          messages: [
            {
              role: "user",
              content: "Please help me organize my calendar.",
              timestamp: simEnv.now(),
            },
          ],
        });
        return result;
      }),
    );

    expect(recordedResult.recordedCalls).toBe(1);
    expect(recordedResult.result.content).toEqual([
      { type: "text", text: "I'll help you with that task." },
    ]);

    // Step 4: Replay the same turn — should produce identical output
    const replayScripts = new Map(recordScripts);
    const replayer = createModelReplayer({ scripts: replayScripts });

    const replayedResult = await withSimulationEnvAsync(simEnv, () =>
      replayer.run(() =>
        completeSimple(demoModel, {
          messages: [
            {
              role: "user",
              content: "Please help me organize my calendar.",
              timestamp: simEnv.now(),
            },
          ],
        }),
      ),
    );

    expect(replayedResult.content).toEqual(recordedResult.result.content);
    expect(replayedResult.stopReason).toBe(recordedResult.result.stopReason);
    expect(replayedResult.usage).toEqual(recordedResult.result.usage);

    // Step 5: recordThenReplay convenience
    const { scripts, recordResult, replayResult } = await recordThenReplay({
      seed: "demo-seed-42",
      run: async () =>
        completeSimple(demoModel, {
          messages: [
            {
              role: "user",
              content: "Please help me organize my calendar.",
              timestamp: simEnv.now(),
            },
          ],
        }),
    });

    expect(scripts.size).toBe(1);
    expect(recordResult.result.content).toEqual(replayResult.content);

    unregisterApiProviders(DEMO_SOURCE_ID);
  });
});
