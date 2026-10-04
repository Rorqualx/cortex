import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../packages/agent-core/src/agent.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { Message, Model } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import {
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
  preExecutionBlockedToolCallIds,
  recordToolExecutionStarted,
  recordToolExecutionTracked,
  resetAdjustedParamsByToolCallIdForTests,
} from "./agent-tools.before-tool-call.state.js";
import { buildPayloads } from "./embedded-agent-runner/run/payloads.test-helpers.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { inferToolMetaFromArgsCore } from "./tool-display.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";

const steeringModel: Model = {
  id: "tool-terminal-steering-model",
  name: "Tool terminal steering model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};

describe("tool terminal outcome observer", () => {
  afterEach(() => resetAdjustedParamsByToolCallIdForTests());

  it.each([
    { firstOutcome: "success", error: undefined, warnings: [] },
    { firstOutcome: "failure", error: "Original tool failure", warnings: ["⚠️ Exec failed"] },
    { firstOutcome: "blocked", error: "Original admission failure", warnings: ["⚠️ Exec blocked"] },
  ])(
    "classifies a steering skip after $firstOutcome through the registered subscription",
    async ({ firstOutcome, error, warnings }) => {
      const firstSettled = createDeferred();
      const releaseFirst = createDeferred();
      const execute = vi.fn(async () => {
        if (firstOutcome === "failure") {
          throw new Error("Original tool failure");
        }
        return { content: [{ type: "text" as const, text: "first completed" }], details: {} };
      });
      const providerRequests: Message[][] = [];
      const { emit, subscription } = createSubscribedSessionHarness({ runId: "steering-warning" });
      const agent = new Agent({
        initialState: {
          model: steeringModel,
          tools: [
            {
              name: "exec",
              label: "exec",
              description: "Runs a step.",
              parameters: Type.Object({}),
              execute,
            },
          ],
        },
        streamFn: (_model, context) => {
          providerRequests.push(context.messages.slice());
          const message = makeAgentAssistantMessage(
            providerRequests.length === 1
              ? {
                  content: [
                    // A blocked call does not start the plan, so an executed call precedes it.
                    ...(firstOutcome === "blocked"
                      ? [
                          {
                            type: "toolCall" as const,
                            id: "call-started",
                            name: "exec",
                            arguments: {},
                          },
                        ]
                      : []),
                    { type: "toolCall", id: "call-first", name: "exec", arguments: {} },
                    { type: "toolCall", id: "call-second", name: "exec", arguments: {} },
                  ],
                  stopReason: "toolUse",
                }
              : { content: [] },
          );
          const stream = createAssistantMessageEventStream();
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
          stream.end();
          return stream;
        },
        toolExecution: "sequential",
        beforeToolCall: async ({ toolCall }) =>
          firstOutcome === "blocked" && toolCall.id === "call-first"
            ? { block: true, reason: "Original admission failure" }
            : undefined,
        afterToolOutcome: async ({ toolCall }) => {
          if (toolCall.id === "call-first") {
            firstSettled.resolve();
            await releaseFirst.promise;
          }
        },
      });
      const unsubscribe = agent.subscribe(emit);
      const run = agent.prompt("start the sequence");
      try {
        await firstSettled.promise;
        agent.steer({ role: "user", content: "change direction", timestamp: 1 });
        releaseFirst.resolve();
        await run;
        await subscription.waitForPendingEvents();

        expect(execute).toHaveBeenCalledTimes(1);
        expect(providerRequests).toHaveLength(2);
        expect(providerRequests[1]?.slice(-2)).toMatchObject([
          {
            role: "toolResult",
            toolCallId: "call-second",
            isError: true,
            details: { status: "skipped", deniedReason: "steering" },
          },
          { role: "user", content: "change direction" },
        ]);
        const lastToolError = subscription.getLastToolError();
        expect(lastToolError?.error).toBe(error);
        expect(
          buildPayloads({
            assistantTexts: subscription.assistantTexts,
            lastAssistant: subscription.getCurrentAttemptAssistant(),
            lastToolError,
          }).map((payload) => payload.text),
        ).toEqual(warnings);
      } finally {
        releaseFirst.resolve();
        await run;
        unsubscribe();
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    {
      name: "admission failure",
      executionStarted: false,
      details: { status: "blocked", deniedReason: "tool-admission" },
    },
    {
      name: "other skipped work",
      executionStarted: false,
      details: { status: "skipped", deniedReason: "policy" },
    },
    {
      name: "executed steering-lookalike result",
      executionStarted: true,
      details: { status: "skipped", deniedReason: "steering" },
    },
  ])("keeps $name as a failure", ({ executionStarted, details }) => {
    const terminal = createToolTerminalObserver("run-non-steering-failure")({
      toolName: "exec",
      executionStarted,
      outcome: "failure",
      result: { details },
      failure: { error: "Original failure" },
    });
    expect(terminal.lastToolError).toMatchObject({ error: "Original failure", executionStarted });
    expect(
      buildPayloads({ lastToolError: terminal.lastToolError }).map((payload) => payload.text),
    ).toEqual([executionStarted ? "⚠️ Exec failed" : "⚠️ Exec blocked"]);
  });

  it("retains a genuine message failure across suppression until a real send succeeds", () => {
    const observe = createToolTerminalObserver("run-suppression");
    const suppression = {
      toolName: "message",
      arguments: { action: "send", target: "123", message: "omitted" },
      outcome: "success" as const,
      result: { details: { status: "suppressed", reason: "cancelled_by_message_sending_hook" } },
    };
    expect(observe(suppression).lastToolError).toBeUndefined();
    observe({
      toolName: "message",
      arguments: { action: "send", target: "123", message: "failed" },
      outcome: "failure",
      failure: { error: "Telegram transport failed" },
    });
    const afterSuppression = observe(suppression);
    expect(afterSuppression.lastToolError).toMatchObject({ error: "Telegram transport failed" });
    expect(buildPayloads({ lastToolError: afterSuppression.lastToolError })).toEqual([
      expect.objectContaining({ isError: true }),
    ]);
    expect(
      observe({
        toolName: "message",
        arguments: { action: "send", target: "123", message: "delivered" },
        outcome: "success",
        result: { details: { ok: true, messageId: "sent-1" } },
      }).lastToolError,
    ).toBeUndefined();
  });

  it("keeps the latest failure when a different tool succeeds", () => {
    const observe = createToolTerminalObserver("run-1");
    const actionA = { action: "send", to: "channel:a", message: "A" };
    const actionB = { action: "send", to: "channel:b", message: "B" };

    observe({
      toolName: "message",
      arguments: actionA,
      outcome: "failure",
      failure: { error: "A failed" },
    });
    observe({
      toolName: "message",
      arguments: actionB,
      outcome: "failure",
      failure: { error: "B failed" },
    });
    const afterB = observe({ toolName: "message", arguments: actionB, outcome: "success" });

    expect(afterB.lastToolError).toMatchObject({
      error: "A failed",
      actionFingerprint: expect.stringContaining("to=channel:a"),
    });
    expect(afterB.lastToolRecovery).toEqual({ toolName: "message" });
    expect(
      observe({ toolName: "heartbeat_respond", arguments: {}, outcome: "success" }).lastToolError,
    ).toMatchObject({ error: "A failed" });
    expect(
      observe({ toolName: "message", arguments: actionA, outcome: "success" }).lastToolError,
    ).toBeUndefined();
  });

  it("surfaces the successful cross-tool recovery without leaking failure details", () => {
    const observe = createToolTerminalObserver("run-edit-recovery");

    observe({
      toolName: "edit",
      arguments: { path: "/tmp/demo.txt", oldText: "missing", newText: "after" },
      outcome: "failure",
      failure: { error: "Could not find TOP_SECRET text in /tmp/demo.txt" },
    });
    const recovered = observe({
      toolName: "write",
      arguments: { path: "/tmp/demo.txt", content: "after" },
      outcome: "success",
    });
    const afterRead = observe({
      toolName: "read",
      arguments: { path: "/tmp/demo.txt" },
      outcome: "success",
    });
    const payloads = buildPayloads({ lastToolRecovery: afterRead.lastToolRecovery });

    expect(recovered.lastToolError).toBeUndefined();
    expect(recovered.lastToolRecovery).toEqual({ toolName: "write" });
    expect(afterRead.lastToolRecovery).toEqual({ toolName: "write" });
    expect(payloads.map((payload) => payload.text)).toEqual(["✅ ✍️ Write succeeded after retry."]);
    expect(JSON.stringify(payloads)).not.toContain("TOP_SECRET");
    expect(JSON.stringify(payloads)).not.toContain("/tmp/demo.txt");

    const afterUnrelatedFailure = observe({
      toolName: "message",
      arguments: { action: "send", to: "channel:other", message: "hello" },
      outcome: "failure",
      failure: { error: "send failed" },
    });
    expect(afterUnrelatedFailure.lastToolError).toMatchObject({ error: "send failed" });
    expect(afterUnrelatedFailure.lastToolRecovery).toEqual({ toolName: "write" });

    const afterSameTargetFailure = observe({
      toolName: "edit",
      arguments: { path: "/tmp/demo.txt", oldText: "after", newText: "later" },
      outcome: "failure",
      failure: { error: "second edit failed" },
    });
    expect(afterSameTargetFailure.lastToolRecovery).toBeUndefined();
  });

  it("uses host execution and adjusted-argument evidence before fallback facts", () => {
    const runId = "run-2";
    const toolCallId = "call-1";
    recordToolExecutionTracked(toolCallId, runId);
    adjustedParamsByToolCallId.set(buildAdjustedParamsKey({ runId, toolCallId }), {
      action: "send",
      to: "channel:adjusted",
    });

    const resolution = createToolTerminalObserver(runId)({
      toolCallId,
      toolName: "message",
      arguments: { action: "send", to: "channel:original" },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "blocked before execution" },
    });

    expect(resolution).toMatchObject({
      executionStarted: false,
      executedArguments: { action: "send", to: "channel:adjusted" },
      sideEffectEvidence: false,
      lastToolError: { mutatingAction: false },
    });
    expect(adjustedParamsByToolCallId.get(buildAdjustedParamsKey({ runId, toolCallId }))).toEqual({
      action: "send",
      to: "channel:adjusted",
    });
  });

  it("resolves active wrapper truth when a racing runtime omits conservative facts", () => {
    const runId = "run-racing-timeout";
    const toolCallId = "call-racing-timeout";
    recordToolExecutionStarted(toolCallId, runId);
    adjustedParamsByToolCallId.set(buildAdjustedParamsKey({ runId, toolCallId }), {
      action: "send",
      to: "channel:adjusted",
    });

    const resolution = createToolTerminalObserver(runId)({
      toolCallId,
      toolName: "message",
      arguments: { action: "send", to: "channel:original" },
      outcome: "failure",
      failure: { error: "timed out during execution", executionStarted: false },
    });

    expect(resolution).toMatchObject({
      executionStarted: true,
      executedArguments: { action: "send", to: "channel:adjusted" },
      sideEffectEvidence: true,
      lastToolError: { executionStarted: true, mutatingAction: true },
    });
  });

  it("uses settled pre-execution evidence after active tracking is released", () => {
    const runId = "run-3";
    const toolCallId = "call-blocked";
    preExecutionBlockedToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));

    const resolution = createToolTerminalObserver(runId)({
      toolCallId,
      toolName: "message",
      arguments: { action: "send", to: "channel:blocked" },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "blocked" },
    });

    expect(resolution).toMatchObject({
      executionStarted: false,
      sideEffectEvidence: false,
      lastToolError: { executionStarted: false, mutatingAction: false },
    });
  });

  it.each([
    {
      name: "pre-execution rejection",
      input: {
        toolName: "message",
        arguments: { action: "send" },
        executionStarted: false,
        outcome: "failure",
        failure: { error: "blocked" },
      },
      state: "uncertain",
    },
    {
      name: "completed read",
      input: { toolName: "message", arguments: { action: "read" }, outcome: "success" },
      state: "read_completed",
    },
    {
      name: "failed read",
      input: {
        toolName: "message",
        arguments: { action: "read" },
        outcome: "failure",
        failure: { error: "read failed" },
      },
      state: "failed_no_effect",
    },
    {
      name: "completed computer observation",
      input: { toolName: "computer", arguments: { action: "list_windows" }, outcome: "success" },
      state: "read_completed",
    },
    {
      name: "failed computer observation",
      input: {
        toolName: "computer",
        arguments: { action: "get_cursor_position" },
        outcome: "failure",
        failure: { error: "observation unavailable" },
      },
      state: "failed_no_effect",
    },
    {
      name: "owner-declared replay-safe failure",
      input: {
        toolName: "plugin_read",
        arguments: {},
        replaySafe: true,
        outcome: "failure",
        failure: { error: "read failed" },
      },
      state: "failed_no_effect",
    },
    {
      name: "completed mutation",
      input: { toolName: "message", arguments: { action: "send" }, outcome: "success" },
      state: "mutation_committed",
    },
    {
      name: "completed unknown operation",
      input: { toolName: "plugin_unknown", arguments: {}, outcome: "success" },
      state: "uncertain",
    },
    {
      name: "failed mutation",
      input: {
        toolName: "message",
        arguments: { action: "send" },
        outcome: "failure",
        failure: { error: "send failed" },
      },
      state: "uncertain",
    },
  ] as const)("records a host-owned effect receipt for $name", ({ input, state }) => {
    expect(createToolTerminalObserver("run-effect-receipt")(input).effectReceipt).toEqual({
      state,
    });
  });

  it("clears a failed sessions_spawn once a retry with adjusted arguments succeeds", () => {
    const observe = createToolTerminalObserver("run-spawn-retry");
    const failedArgs = {
      task: "Investigate the flaky gateway test",
      label: "Investigate",
      cwd: "/outside/workspace",
    };
    // The retry the model actually issues: drops the rejected cwd and rewords the task.
    const retryArgs = { task: "Investigate the flaky gateway test in repo scope" };

    observe({
      toolName: "sessions_spawn",
      arguments: failedArgs,
      meta: inferToolMetaFromArgsCore("sessions_spawn", failedArgs),
      outcome: "failure",
      failure: { error: "cwd is outside the workspace" },
    });
    const afterRetry = observe({
      toolName: "sessions_spawn",
      arguments: retryArgs,
      meta: inferToolMetaFromArgsCore("sessions_spawn", retryArgs),
      outcome: "success",
    });

    expect(afterRetry.lastToolError).toBeUndefined();
    expect(afterRetry.lastToolRecovery).toEqual({ toolName: "sessions_spawn" });

    const payloads = buildPayloads({
      assistantTexts: ["Started Investigate in a new session."],
      lastToolError: afterRetry.lastToolError,
      lastToolRecovery: afterRetry.lastToolRecovery,
    });
    expect(payloads.map((payload) => payload.text)).toEqual([
      "Started Investigate in a new session.",
      "✅ 🧑‍🔧 Sub-agent succeeded after retry.",
    ]);
  });

  it("keeps the sessions_spawn failure warning when no later spawn succeeds", () => {
    const observe = createToolTerminalObserver("run-spawn-failed");
    const failedArgs = { task: "Investigate the flaky gateway test", label: "Investigate" };

    const terminal = observe({
      toolName: "sessions_spawn",
      arguments: failedArgs,
      meta: inferToolMetaFromArgsCore("sessions_spawn", failedArgs),
      outcome: "failure",
      failure: { error: "cwd is outside the workspace" },
    });

    const payloads = buildPayloads({
      assistantTexts: ["Started Investigate in a new session."],
      lastToolError: terminal.lastToolError,
      lastToolRecovery: terminal.lastToolRecovery,
    });
    expect(payloads.at(-1)?.isError).toBe(true);
    expect(payloads.at(-1)?.text).toContain("Sub-agent failed");
  });

  it("preserves durable memory recall side-effect evidence", () => {
    const observe = createToolTerminalObserver("run-memory");

    expect(
      observe({
        toolName: "memory_search",
        arguments: { query: "recall" },
        outcome: "success",
      }),
    ).toMatchObject({ executionStarted: true, sideEffectEvidence: true });
    expect(
      observe({
        toolName: "memory_get",
        arguments: { path: "memory/notes.md" },
        outcome: "success",
      }),
    ).toMatchObject({ executionStarted: true, sideEffectEvidence: false });
  });

  it("keeps a failed persistence claim visible, appends a correction, and hides owner metadata", () => {
    const observation = {
      toolName: "memory_store",
      arguments: { text: "The user prefers metric units." },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "429 insufficient_quota" },
      ownerMutation: {
        ownerKey: '["memory-lancedb","memory_store"]',
      },
    } as const;
    const terminal = createToolTerminalObserver("run-memory-store")(observation);

    const payloads = buildPayloads({
      assistantTexts: ["I've saved that preference and will remember it."],
      lastToolError: terminal.lastToolError,
    });

    expect(payloads).toEqual([
      expect.objectContaining({ text: "I've saved that preference and will remember it." }),
      expect.objectContaining({ isError: true }),
    ]);
    expect(JSON.stringify(payloads)).not.toContain("memory-lancedb");
  });

  it("does not treat an unowned same-name tool as a persistence mutation", () => {
    const terminal = createToolTerminalObserver("run-third-party-store")({
      toolName: "memory_store",
      arguments: { text: "The user prefers metric units." },
      executionStarted: true,
      outcome: "failure",
      failure: { error: "store unavailable" },
    });

    expect(terminal.lastToolError).toMatchObject({ mutatingAction: false });
  });

  it("clears a failed persistence action only after the same fact succeeds", () => {
    const observe = createToolTerminalObserver("run-memory-store-retry");
    const ownerKey = '["memory-lancedb","memory_store"]';
    const ownerMutation = { ownerKey };

    observe({
      toolName: "memory_store",
      arguments: { text: "The user prefers metric units." },
      outcome: "failure",
      failure: { error: "store unavailable" },
      ownerMutation,
    });
    expect(
      observe({
        toolName: "memory_store",
        arguments: { text: "The user prefers imperial units." },
        outcome: "success",
        ownerMutation,
      }).lastToolError,
    ).toMatchObject({
      actionFingerprint: expect.stringContaining(`owner=${ownerKey}|args=`),
    });
    expect(
      observe({
        toolName: "memory_store",
        arguments: { text: "The user prefers metric units." },
        outcome: "success",
        ownerMutation,
      }).lastToolError,
    ).toBeUndefined();
  });
});
