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
  // Send the agent's reply as the notification body. The configured `message`
  // is the fallback used only when the completed turn produced no text.
  const fallbackMessage = (hookConfig?.message as string) ?? "✅ Done";
  const replyContent = event.context.content.trim();
  const text = replyContent || fallbackMessage;

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
      payloads: [{ text }],
      bestEffort: true,
    });
    logger.debug("Completion notification sent successfully");
  } catch (err) {
    logger.error("Failed to send completion notification", { error: String(err) });
  }
};

export default handler;
