import { sendDurableMessageBatch } from "../../../channels/message/runtime.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { isMessageSentEvent } from "../../internal-hooks.js";
import { resolveHookConfig } from "../../policy.js";

const logger = createSubsystemLogger("hooks/message-completion-notifier");

const handler: HookHandler = async (event) => {
  if (!isMessageSentEvent(event)) {
    return;
  }

  const cfg: OpenClawConfig | undefined = event.context.cfg;
  if (!cfg) {
    logger.debug("No config in event context, skipping");
    return;
  }

  const hookConfig = resolveHookConfig(cfg, "message-completion-notifier");
  if (hookConfig?.enabled === false) {
    return;
  }

  const watchChannel = (hookConfig?.watchChannel as string) ?? "webchat";
  const notifyChannel = (hookConfig?.notifyChannel as string) ?? "telegram";
  const notifyTo = hookConfig?.notifyTo as string | undefined;
  const notifyAccountId = hookConfig?.notifyAccountId as string | undefined;
  const notifyThreadId = hookConfig?.notifyThreadId as string | number | undefined;
  const message = (hookConfig?.message as string) ?? "✅ Done";

  const channelId = event.context.channelId;
  if (channelId !== watchChannel) {
    return;
  }
  if (channelId === notifyChannel) {
    return;
  }

  if (!notifyTo || !notifyAccountId) {
    logger.warn("notifyTo or notifyAccountId missing, skipping notification");
    return;
  }

  try {
    await sendDurableMessageBatch({
      cfg,
      channel: notifyChannel as Exclude<string, "none">,
      to: notifyTo,
      accountId: notifyAccountId,
      ...(notifyThreadId !== undefined ? { threadId: notifyThreadId } : {}),
      payloads: [{ text: message }],
      bestEffort: true,
    });
    logger.debug("Completion notification sent successfully");
  } catch (err) {
    logger.error("Failed to send completion notification", { error: String(err) });
  }
};

export default handler;
