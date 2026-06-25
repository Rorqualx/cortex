/**
 * Tests for the DST SimulationEnv and scripted model provider.
 */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getApiProvider,
  registerApiProvider,
  unregisterApiProviders,
} from "../../../packages/llm-runtime/src/api-registry.js";
import {
  createModelRecorder,
  createModelReplayer,
  deserializeScripts,
  recordThenReplay,
  serializeScripts,
} from "./record-replay.js";
import {
  computeScriptKey,
  createScriptedApiProvider,
  createUniversalScriptedProvider,
  recordStream,
  replayScript,
  type ModelScript,
  type ScriptStore,
} from "./scripted-model-provider.js";
import {
  createDefaultSimulationEnv,
  createDeterministicSimulationEnv,
  getSimulationEnv,
  setSimulationEnv,
  withSimulationEnv,
  withSimulationEnvAsync,
} from "./simulation-env.js";

const TEST_SOURCE_ID = "test:sim";

const testModel = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.invalid",
  input: ["text"],
  reasoning: false,
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model;

const testContext = {
  messages: [{ role: "user" as const, content: "hello", timestamp: 0 }],
};

/** Helper: creates a mock provider that emits the given events when stream() is called. */
function makeEmittingProvider(
  events: Array<{
    type: string;
    partial?: AssistantMessage;
    message?: AssistantMessage;
    reason?: string;
  }>,
): {
  api: "test-api";
  stream: () => ReturnType<typeof createAssistantMessageEventStream>;
  streamSimple: () => ReturnType<typeof createAssistantMessageEventStream>;
} {
  return {
    api: "test-api" as const,
    stream: () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        for (const event of events) {
          stream.push(event as Parameters<typeof stream.push>[0]);
        }
      });
      return stream;
    },
    streamSimple: () => createAssistantMessageEventStream(),
  };
}

describe("SimulationEnv", () => {
  afterEach(() => {
    setSimulationEnv(undefined);
  });

  it("default env uses Date.now and Math.random", () => {
    const env = createDefaultSimulationEnv();
    const before = Date.now();
    const now = env.now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);

    const r = env.random();
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });

  it("deterministic env produces stable RNG sequence for same seed", () => {
    const env1 = createDeterministicSimulationEnv({ seed: "abc123" });
    const env2 = createDeterministicSimulationEnv({ seed: "abc123" });

    const seq1 = Array.from({ length: 10 }, () => env1.random());
    const seq2 = Array.from({ length: 10 }, () => env2.random());
    expect(seq1).toEqual(seq2);
  });

  it("deterministic env produces different sequences for different seeds", () => {
    const env1 = createDeterministicSimulationEnv({ seed: "seed-a" });
    const env2 = createDeterministicSimulationEnv({ seed: "seed-b" });

    const seq1 = Array.from({ length: 10 }, () => env1.random());
    const seq2 = Array.from({ length: 10 }, () => env2.random());
    expect(seq1).not.toEqual(seq2);
  });

  it("deterministic env virtual clock starts at 0 by default", () => {
    const env = createDeterministicSimulationEnv({ seed: "x" });
    expect(env.now()).toBe(0);
  });

  it("deterministic env virtual clock respects startTimeMs", () => {
    const env = createDeterministicSimulationEnv({ seed: "x", startTimeMs: 1_700_000_000_000 });
    expect(env.now()).toBe(1_700_000_000_000);
  });

  it("get/setSimulationEnv round-trips", () => {
    expect(getSimulationEnv()).toBeUndefined();
    const env = createDeterministicSimulationEnv({ seed: "x" });
    setSimulationEnv(env);
    expect(getSimulationEnv()).toBe(env);
    setSimulationEnv(undefined);
    expect(getSimulationEnv()).toBeUndefined();
  });

  it("withSimulationEnv scopes env correctly", () => {
    const envA = createDeterministicSimulationEnv({ seed: "a" });
    const envB = createDeterministicSimulationEnv({ seed: "b" });
    setSimulationEnv(envA);

    withSimulationEnv(envB, () => {
      expect(getSimulationEnv()).toBe(envB);
    });

    expect(getSimulationEnv()).toBe(envA);
  });

  it("withSimulationEnvAsync scopes env correctly", async () => {
    const envA = createDeterministicSimulationEnv({ seed: "a" });
    const envB = createDeterministicSimulationEnv({ seed: "b" });
    setSimulationEnv(envA);

    await withSimulationEnvAsync(envB, async () => {
      expect(getSimulationEnv()).toBe(envB);
      await Promise.resolve();
      expect(getSimulationEnv()).toBe(envB);
    });

    expect(getSimulationEnv()).toBe(envA);
  });
});

describe("ScriptedModelProvider", () => {
  afterEach(() => {
    unregisterApiProviders(TEST_SOURCE_ID);
    unregisterApiProviders("sim:recorder");
    unregisterApiProviders("sim:replayer");
  });

  it("computeScriptKey is deterministic for identical model+context", () => {
    const key1 = computeScriptKey(testModel, testContext);
    const key2 = computeScriptKey(testModel, testContext);
    expect(key1).toBe(key2);
  });

  it("computeScriptKey differs for different contexts", () => {
    const key1 = computeScriptKey(testModel, testContext);
    const key2 = computeScriptKey(testModel, {
      messages: [{ role: "user" as const, content: "world", timestamp: 0 }],
    });
    expect(key1).not.toBe(key2);
  });

  it("computeScriptKey ignores message timestamps", () => {
    const ctxA = {
      messages: [{ role: "user" as const, content: "hi", timestamp: 1000 }],
    };
    const ctxB = {
      messages: [{ role: "user" as const, content: "hi", timestamp: 2000 }],
    };
    const keyA = computeScriptKey(testModel, ctxA);
    const keyB = computeScriptKey(testModel, ctxB);
    expect(keyA).toBe(keyB);
  });

  it("replayScript reproduces recorded events and final message", async () => {
    const finalMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
      api: testModel.api,
      provider: testModel.provider,
      model: testModel.id,
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    const script: ModelScript = {
      key: "test-key",
      events: [
        { type: "start", partial: finalMessage },
        { type: "text_start", contentIndex: 0, partial: finalMessage },
        { type: "text_delta", contentIndex: 0, delta: "Hello world", partial: finalMessage },
        { type: "text_end", contentIndex: 0, content: "Hello world", partial: finalMessage },
        { type: "done", reason: "stop", message: finalMessage },
      ],
      finalMessage,
      provider: testModel.provider,
      modelId: testModel.id,
      api: testModel.api,
    };

    const stream = replayScript(script);
    const events: Array<{ type: string }> = [];
    for await (const event of stream) {
      events.push(event as { type: string });
    }
    const result = await stream.result();

    expect(events).toHaveLength(5);
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(result).toEqual(finalMessage);
  });

  it("recordStream captures events and final message", async () => {
    const scripts: ScriptStore = new Map();
    const sourceStream = createAssistantMessageEventStream();
    const finalMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Recorded" }],
      api: testModel.api,
      provider: testModel.provider,
      model: testModel.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };

    // Emit events then resolve
    queueMicrotask(() => {
      sourceStream.push({ type: "start", partial: finalMessage });
      sourceStream.push({ type: "done", reason: "stop", message: finalMessage });
    });

    const recorded = recordStream(sourceStream, "key-1", scripts, testModel);
    const events: Array<{ type: string }> = [];
    for await (const event of recorded) {
      events.push(event as { type: string });
    }
    await recorded.result();

    expect(events.map((e) => e.type)).toEqual(["start", "done"]);
    expect(scripts.has("key-1")).toBe(true);
    expect(scripts.get("key-1")?.finalMessage).toEqual(finalMessage);
  });

  it("createScriptedApiProvider in replay mode throws for missing script", () => {
    const scripts: ScriptStore = new Map();
    const provider = createScriptedApiProvider("test-api", {
      mode: "replay",
      scripts,
    });
    registerApiProvider(provider, TEST_SOURCE_ID);

    expect(() => provider.stream(testModel, testContext)).toThrow(/no script found/);
  });

  it("createScriptedApiProvider round-trip: record then replay", async () => {
    const scripts: ScriptStore = new Map();

    const finalMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
      api: testModel.api,
      provider: testModel.provider,
      model: testModel.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };

    // Set up a real provider that emits events when stream() is called
    const realProvider = makeEmittingProvider([
      { type: "start", partial: finalMessage },
      { type: "done", reason: "stop", message: finalMessage },
    ]);
    registerApiProvider(realProvider, TEST_SOURCE_ID);

    // Record
    const recorder = createScriptedApiProvider("test-api", {
      mode: "record",
      scripts,
      realProvider: getApiProvider("test-api"),
    });

    const recordedStream = recorder.stream(testModel, testContext);
    await Array.fromAsync(recordedStream);
    await recordedStream.result();

    expect(scripts.size).toBe(1);

    // Replay
    const replayer = createScriptedApiProvider("test-api", {
      mode: "replay",
      scripts,
    });
    const replayStream = replayer.stream(testModel, testContext);
    const replayEvents: Array<{ type: string }> = [];
    for await (const event of replayStream) {
      replayEvents.push(event as { type: string });
    }
    const replayResult = await replayStream.result();

    expect(replayEvents.map((e) => e.type)).toEqual(["start", "done"]);
    expect(replayResult).toEqual(finalMessage);
  });
});

describe("RecordReplayHarness", () => {
  afterEach(() => {
    unregisterApiProviders(TEST_SOURCE_ID);
    unregisterApiProviders("sim:recorder");
    unregisterApiProviders("sim:replayer");
  });

  it("createModelRecorder captures calls and restores providers after", async () => {
    const scripts: ScriptStore = new Map();
    const finalMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      api: testModel.api,
      provider: testModel.provider,
      model: testModel.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    const realProvider = makeEmittingProvider([
      { type: "done", reason: "stop", message: finalMessage },
    ]);
    registerApiProvider(realProvider, TEST_SOURCE_ID);

    const recorder = createModelRecorder({ scripts });
    const result = await recorder.run(async () => {
      const p = getApiProvider("test-api");
      expect(p).toBeDefined();
      const s = p!.stream(testModel, testContext);
      await Array.fromAsync(s);
      return "ok";
    });

    expect(result.result).toBe("ok");
    expect(result.recordedCalls).toBe(1);

    // After the recorder finishes, providers should be restored
    const restored = getApiProvider("test-api");
    expect(restored).toBeDefined();
  });

  it("createModelReplayer replays deterministically", async () => {
    const scripts: ScriptStore = new Map();
    const realProvider = {
      api: "test-api" as const,
      stream: () => createAssistantMessageEventStream(),
      streamSimple: () => createAssistantMessageEventStream(),
    };
    registerApiProvider(realProvider, TEST_SOURCE_ID);

    // Pre-populate a script
    const key = computeScriptKey(testModel, testContext);
    const finalMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Replayed" }],
      api: testModel.api,
      provider: testModel.provider,
      model: testModel.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    scripts.set(key, {
      key,
      events: [
        { type: "start", partial: finalMessage },
        { type: "done", reason: "stop", message: finalMessage },
      ],
      finalMessage,
      provider: testModel.provider,
      modelId: testModel.id,
      api: testModel.api,
    });

    const replayer = createModelReplayer({ scripts });
    const events: Array<{ type: string }> = [];
    await replayer.run(async () => {
      const p = getApiProvider("test-api");
      const s = p!.stream(testModel, testContext);
      for await (const event of s) {
        events.push(event as { type: string });
      }
    });

    expect(events.map((e) => e.type)).toEqual(["start", "done"]);
  });

  it("serializeScripts and deserializeScripts round-trip", () => {
    const scripts: ScriptStore = new Map();
    const key = computeScriptKey(testModel, testContext);
    const finalMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Round-trip" }],
      api: testModel.api,
      provider: testModel.provider,
      model: testModel.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    scripts.set(key, {
      key,
      events: [
        { type: "start", partial: finalMessage },
        { type: "done", reason: "stop", message: finalMessage },
      ],
      finalMessage,
      provider: testModel.provider,
      modelId: testModel.id,
      api: testModel.api,
    });

    const serialized = serializeScripts(scripts);
    const deserialized = deserializeScripts(serialized);

    expect(deserialized.size).toBe(1);
    const script = deserialized.get(key)!;
    expect(script.finalMessage.content).toEqual([{ type: "text", text: "Round-trip" }]);
    expect(script.events).toHaveLength(2);
  });

  it("recordThenReplay captures and replays", async () => {
    const finalMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello from replay" }],
      api: testModel.api,
      provider: testModel.provider,
      model: testModel.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    const realProvider = makeEmittingProvider([
      { type: "done", reason: "stop", message: finalMessage },
    ]);
    registerApiProvider(realProvider, TEST_SOURCE_ID);

    let callCount = 0;
    const { scripts, recordResult, replayResult } = await recordThenReplay({
      seed: "test-seed",
      run: async () => {
        callCount++;
        const p = getApiProvider("test-api");
        const s = p!.stream(testModel, testContext);
        await Array.fromAsync(s);
        return { callCount };
      },
    });

    expect(scripts.size).toBe(1);
    expect(recordResult.result.callCount).toBe(1);
    expect(recordResult.recordedCalls).toBe(1);
    // recordThenReplay calls the run function twice: once for record, once for replay.
    // The scripted provider intercepts model calls on replay but the outer closure
    // still executes, so callCount ends up at 2.
    expect(replayResult.callCount).toBe(2);
  });
});
