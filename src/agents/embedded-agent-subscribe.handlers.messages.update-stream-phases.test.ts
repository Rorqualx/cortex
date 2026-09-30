import { describe, expect, it, vi } from "vitest";
import { consumePendingAssistantReplyDirectivesIntoReply } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import {
  createMessageUpdateContext,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import {
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent as createTextUpdateEvent,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";

function twoBlockPartial() {
  return {
    role: "assistant",
    phase: "final_answer",
    api: "openai-responses",
    content: [
      createOpenAiResponsesTextBlock({ text: "First block", id: "item-1", phase: "final_answer" }),
      createOpenAiResponsesTextBlock({ text: "Second block", id: "item-2", phase: "final_answer" }),
    ],
  };
}

describe("handleMessageUpdate text signatures", () => {
  it("emits a commentary snapshot when Anthropic text is classified after deltas", async () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const narration = "I'll check the repo first.";
    const commentaryPartial = {
      role: "assistant",
      api: "anthropic-messages",
      content: [
        {
          type: "text",
          text: narration,
          textSignature: JSON.stringify({ v: 1, id: "commentary-0", phase: "commentary" }),
        },
      ],
    };

    await updateMessage(context, {
      message: {
        role: "assistant",
        api: "anthropic-messages",
        content: [{ type: "text", text: narration }],
      },
      assistantMessageEvent: { type: "text_delta", delta: narration },
    });
    await updateMessage(context, {
      message: { role: "assistant", api: "anthropic-messages", content: [] },
      assistantMessageEvent: {
        type: "text_end",
        content: narration,
        partial: commentaryPartial,
      },
    });

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toContainEqual(
      expect.objectContaining({
        stream: "assistant",
        data: expect.objectContaining({
          text: narration,
          replace: true,
          phase: "commentary",
          itemId: "commentary-0",
        }),
      }),
    );
  });

  it.each([
    {
      name: "user-visible sanitizer",
      chunks: [
        "Visible\n<tool_call>{",
        '"name":"read","arguments":{"file_path":"secret.md"}}</tool_call>',
        "\nDone.",
      ],
      updates: [
        { text: "Visible", delta: "Visible" },
        { text: "Visible\n\nDone.", delta: "\n\nDone." },
      ],
    },

    {
      name: "split voice directive",
      chunks: ["[[audio_as_", "voice]]Hello", " world"],
      updates: [
        { text: "Hello", delta: "Hello" },
        { text: "Hello world", delta: " world" },
      ],
      reply: { audioAsVoice: true },
    },
    {
      name: "split reply target",
      chunks: ["[[reply_to:", "message-7]]Hello", " world"],
      updates: [
        { text: "Hello", delta: "Hello" },
        { text: "Hello world", delta: " world" },
      ],
      reply: { replyToId: "message-7", replyToTag: true },
    },
    {
      name: "duplicate paragraph becomes distinct",
      chunks: ["One.\n\n", "One.", " More."],
      updates: [
        { text: "One.", delta: "One." },
        { text: "One.\n\nOne. More.", delta: "\n\nOne. More." },
      ],
    },
  ])(
    "uses append events for same-item phased streams ($name)",
    async ({ chunks, updates, reply }) => {
      const onAgentEvent = vi.fn();
      const context = createMessageUpdateContext({ onAgentEvent });
      const signature = JSON.stringify({ v: 1, id: "item-final", phase: "final_answer" });
      const partial = {
        role: "assistant",
        phase: "final_answer",
        content: [
          {
            type: "text",
            textSignature: signature,
            get text() {
              throw new Error("full partial text should not be read");
            },
          },
        ],
      };

      const createPhasedDelta = (delta: string) =>
        ({
          message: { role: "assistant", content: [] },
          assistantMessageEvent: {
            type: "text_delta",
            delta,
            partial,
          },
        }) as never;

      for (const chunk of chunks) {
        await updateMessage(context, createPhasedDelta(chunk));
      }

      expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject(
        updates.map((data) => ({
          stream: "assistant",
          data: { ...data, replace: undefined, phase: "final_answer" },
        })),
      );
      if (reply) {
        expect(
          consumePendingAssistantReplyDirectivesIntoReply(context.state, { text: "Hello world" }),
        ).toMatchObject(reply);
      }
    },
  );

  it.each([""])("replaces a phased reply with the final snapshot %j", async (finalText) => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    for (const event of [
      { type: "text_delta" as const, text: "Hello world", delta: "Hello world" },
      { type: "text_delta" as const, text: "", delta: "" },
      { type: "text_end" as const, text: finalText },
    ]) {
      const pending = updateMessage(
        context,
        createTextUpdateEvent({
          ...event,
          id: "item-final",
          signaturePhase: "final_answer",
          partialPhase: "final_answer",
        }),
      );
      if (event.type === "text_delta") {
        expect(onAgentEvent).toHaveBeenCalledTimes(1);
      }
      await pending;
    }

    expect(onAgentEvent.mock.calls.map(([event]) => event)).toMatchObject([
      {
        stream: "assistant",
        data: { text: "Hello world", delta: "Hello world", replace: undefined },
      },
      { stream: "assistant", data: { text: finalText, delta: "", replace: true } },
    ]);
    expect(context.blockChunker.bufferedText).toBe(finalText);
  });

  it("does not replay a deferred item snapshot before its first delta", async () => {
    const flushBlockReplyBuffer = vi.fn();
    const resetAssistantMessageState = vi.fn();
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();
    const context = createMessageUpdateContext({
      flushBlockReplyBuffer,
      resetAssistantMessageState,
      onPartialReply,
      state: {
        lastAssistantStreamContentIndex: 0,
        lastAssistantStreamItemId: "item-1",
        assistantMessageIndex: 7,
      },
    });
    context.params.onAssistantMessageStart = onAssistantMessageStart;
    const partial = twoBlockPartial();

    const startPending = updateMessage(context, {
      message: partial,
      assistantMessageEvent: {
        type: "text_start",
        contentIndex: 1,
        partial,
      },
    });
    const deltaPending = updateMessage(context, {
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Second block",
      },
    });

    expect(flushBlockReplyBuffer).toHaveBeenCalledExactlyOnceWith({ assistantMessageIndex: 7 });
    expect(resetAssistantMessageState).toHaveBeenCalledExactlyOnceWith(0);
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Second block",
        delta: "Second block",
        phase: "final_answer",
      }),
    );
    expect(context.state.lastAssistantStreamContentIndex).toBe(1);
    expect(context.state.lastAssistantStreamItemId).toBe("item-2");
    await Promise.all([startPending, deltaPending]);
  });

  it("scopes item-id fallback boundaries to the matching signed block", async () => {
    const onPartialReply = vi.fn();
    const resetAssistantMessageState = vi.fn();
    const context = createMessageUpdateContext({
      onPartialReply,
      resetAssistantMessageState,
      state: { lastAssistantStreamItemId: "item-1" },
    });

    await updateMessage(context, {
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Second block",
        partial: twoBlockPartial(),
      },
    });

    expect(resetAssistantMessageState).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Second block",
        delta: "Second block",
        phase: "final_answer",
      }),
    );
    expect(onPartialReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "First block\nSecond block" }),
    );
    expect(context.state.lastAssistantStreamContentIndex).toBeUndefined();
    expect(context.state.lastAssistantStreamItemId).toBe("item-2");
  });

  it("preserves phase-aware voice and reply directives while deferring final media delivery", async () => {
    const ctx = createMessageUpdateContext({
      state: {
        blockReplyBreak: "message_end",
      },
    });
    const replyText = "Done.\n\n[[reply_to_current]]\n[[audio_as_voice]]\nMEDIA:/tmp/reply.ogg";

    for (const type of ["text_delta", "text_end"] as const) {
      await updateMessage(
        ctx,
        createTextUpdateEvent({
          type,
          text: replyText,
          id: "item-final",
          signaturePhase: "final_answer",
          partialPhase: "final_answer",
        }),
      );
    }

    expect(ctx.blockChunker.bufferedText).toBe("Done.\n\n");
    expect(
      consumePendingAssistantReplyDirectivesIntoReply(ctx.state, {
        text: "Done.",
      }),
    ).toEqual({
      text: "Done.",
      audioAsVoice: true,
      replyToId: undefined,
      replyToTag: true,
      replyToCurrent: true,
    });
    expect(ctx.state.pendingAssistantReplyDirectives).toBeUndefined();
  });
});
