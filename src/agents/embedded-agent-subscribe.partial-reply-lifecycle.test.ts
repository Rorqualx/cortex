import { beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  isEnabled: vi.fn(() => false),
  trace: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => logger,
}));

import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
} from "./embedded-agent-subscribe.e2e-harness.js";

function emitPartialThenProviderFailure(emit: (event: unknown) => void): void {
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: "partial answer" },
  });
  const failedAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "partial answer" }],
    stopReason: "error",
    errorMessage: "provider failed after partial",
    provider: "test-provider",
    model: "test-model",
  };
  emit({ type: "message_end", message: failedAssistant });
  emit({ type: "agent_end", messages: [failedAssistant], willRetry: false });
}

describe("subscribeEmbeddedAgentSession partial reply lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("joins a partial reply task created while terminal events settle", async () => {
    let resolvePartial: (() => void) | undefined;
    const onPartialReply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePartial = resolve;
        }),
    );
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-partial-provider-failure",
      onBeforeTerminalDelivery: async () => undefined,
      onPartialReply,
    });

    emitPartialThenProviderFailure(emit);
    let settled = false;
    const settlement = subscription.waitForPendingEvents().then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).toBe(false);

    resolvePartial?.();
    await settlement;
    expect(settled).toBe(true);
  });

  it("contains and logs a rejected partial reply after unsubscribe", async () => {
    const callbackError = new Error("draft send rejected");
    let rejectPartial: ((reason: unknown) => void) | undefined;
    const onPartialReply = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPartial = reject;
        }),
    );
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-partial-rejection",
      onPartialReply,
    });

    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "partial answer" },
    });

    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());
    emitAssistantTextDelta({ emit, delta: " queued" });
    emitAssistantTextDelta({ emit, delta: " tail" });
    await subscription.waitForPendingEvents();
    expect(onPartialReply).toHaveBeenCalledOnce();
    subscription.unsubscribe();
    rejectPartial?.(callbackError);
    await expect(subscription.waitForPendingEvents()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      `assistant partial reply callback failed: ${String(callbackError)}`,
    );
    expect(onPartialReply).toHaveBeenCalledOnce();
  });
});

describe("native reasoning projection", () => {
  it.for([
    { name: "trailing whitespace", chunks: ["a ", "b"] },
    { name: "whitespace-only chunk", chunks: ["abc", " ", "def"] },
    { name: "whitespace-only reasoning", chunks: ["  ", " ", "\n"] },
    { name: "leading and trailing whitespace", chunks: ["  ", "a  ", "b ", "  ", "c"] },
  ])("preserves $name through transport and subscription", async ({ chunks }, { signal }) => {
    const measurement = await measureNativeReasoningSubscription({ chunks, signal });
    expect(measurement.textMatches).toBe(true);
    expect(measurement.deltaMatches).toBe(true);
  });

  it("does not rescan the growing reasoning prefix on every provider delta", async ({ signal }) => {
    const runId = "native-reasoning-prefix-work";
    const probe = vi.spyOn(String.prototype, "startsWith");
    let comparedPrefixChars = 0;
    const collectPrefixWork = () => {
      for (const [index, [search, position]] of probe.mock.calls.entries()) {
        const text = probe.mock.contexts[index];
        if (
          typeof text === "string" &&
          typeof search === "string" &&
          (position ?? 0) === 0 &&
          text.slice(0, NATIVE_REASONING_BENCH_PREFIX.length) === NATIVE_REASONING_BENCH_PREFIX &&
          search.length > NATIVE_REASONING_BENCH_PREFIX.length
        ) {
          comparedPrefixChars += search.length;
        }
      }
      // Keeping every argument would itself retain all historical prefixes.
      probe.mockClear();
    };
    const off = onAgentEventForRun(runId, collectPrefixWork);
    try {
      const measurement = await measureNativeReasoningSubscription({ signal, runId });
      collectPrefixWork();
      console.log("native-reasoning-work", JSON.stringify({ ...measurement, comparedPrefixChars }));
      expect(measurement.textMatches).toBe(true);
      expect(measurement.deltaMatches).toBe(true);
      expect(measurement.events).toBe(measurement.chunks);
      expect(comparedPrefixChars).toBeLessThan(measurement.chars * 4);
    } finally {
      off();
      probe.mockRestore();
    }
  });
});
