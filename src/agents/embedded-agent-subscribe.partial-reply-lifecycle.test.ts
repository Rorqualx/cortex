import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

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
    const partial = createDeferred();
    const onPartialReply = vi.fn(() => partial.promise);
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

    partial.resolve();
    await settlement;
    expect(settled).toBe(true);
  });

  it("contains and logs a rejected partial reply after unsubscribe", async () => {
    const callbackError = new Error("draft send rejected");
    const partial = createDeferred();
    const onPartialReply = vi.fn(() => partial.promise);
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
    partial.reject(callbackError);
    await expect(subscription.waitForPendingEvents()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      `assistant partial reply callback failed: ${String(callbackError)}`,
    );
    expect(onPartialReply).toHaveBeenCalledOnce();
  });
});
