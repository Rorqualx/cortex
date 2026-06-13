// message-completion-notifier tests cover watched-channel filtering and best-effort delivery.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendDurableMessageBatch } from "../../../channels/message/runtime.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

vi.mock("../../../channels/message/runtime.js", () => ({
  sendDurableMessageBatch: vi.fn().mockResolvedValue(undefined),
}));

const sendBatch = vi.mocked(sendDurableMessageBatch);

function notifierConfig(entry: Record<string, unknown> | undefined): OpenClawConfig {
  const entries = entry ? { "message-completion-notifier": entry } : {};
  return {
    hooks: {
      internal: { entries },
    },
  } as OpenClawConfig;
}

function messageSentEvent(params: {
  cfg?: OpenClawConfig;
  channelId?: string;
  to?: string;
  success?: boolean;
  content?: string;
}) {
  return createHookEvent("message", "sent", "agent:main:main", {
    ...(params.cfg ? { cfg: params.cfg } : {}),
    to: params.to ?? "user-1",
    content: params.content ?? "All done",
    channelId: params.channelId ?? "webchat",
    success: params.success ?? true,
  });
}

const configuredEntry = {
  notifyTo: "12345",
  notifyAccountId: "default",
};

beforeEach(() => {
  sendBatch.mockClear();
});

describe("message-completion-notifier hook", () => {
  it("sends the agent's reply as the notification body on a watched channel", async () => {
    await handler(messageSentEvent({ cfg: notifierConfig(configuredEntry), content: "All done" }));

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "12345",
        accountId: "default",
        payloads: [{ text: "All done" }],
        bestEffort: true,
      }),
    );
  });

  it("falls back to the configured message when the turn produced no reply text", async () => {
    const cfg = notifierConfig({ ...configuredEntry, message: "✅ Done" });

    await handler(messageSentEvent({ cfg, content: "   " }));

    expect(sendBatch).toHaveBeenCalledWith(
      expect.objectContaining({ payloads: [{ text: "✅ Done" }] }),
    );
  });

  it("honors custom watch/notify channels and thread id", async () => {
    const cfg = notifierConfig({
      ...configuredEntry,
      watchChannel: "discord",
      notifyChannel: "slack",
      notifyThreadId: 42,
    });

    await handler(messageSentEvent({ cfg, channelId: "discord", content: "Session finished" }));

    expect(sendBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        threadId: 42,
        payloads: [{ text: "Session finished" }],
      }),
    );
  });

  it("skips events that are not message:sent", async () => {
    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: notifierConfig(configuredEntry),
    });

    await handler(event);

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("skips when no config is present in the event context", async () => {
    await handler(messageSentEvent({}));

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("skips when the hook is disabled", async () => {
    await handler(
      messageSentEvent({ cfg: notifierConfig({ ...configuredEntry, enabled: false }) }),
    );

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("skips messages on non-watched channels", async () => {
    await handler(messageSentEvent({ cfg: notifierConfig(configuredEntry), channelId: "slack" }));

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("never notifies the channel it watches (no echo loops)", async () => {
    const cfg = notifierConfig({
      ...configuredEntry,
      watchChannel: "telegram",
      notifyChannel: "telegram",
    });

    await handler(messageSentEvent({ cfg, channelId: "telegram" }));

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("skips when notifyTo or notifyAccountId is missing", async () => {
    await handler(messageSentEvent({ cfg: notifierConfig({ notifyTo: "12345" }) }));
    await handler(messageSentEvent({ cfg: notifierConfig({ notifyAccountId: "default" }) }));

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("swallows delivery failures without throwing", async () => {
    sendBatch.mockRejectedValueOnce(new Error("telegram unavailable"));

    await expect(
      handler(messageSentEvent({ cfg: notifierConfig(configuredEntry) })),
    ).resolves.toBeUndefined();
  });
});
