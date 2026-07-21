// Auto-title generation for webchat sessions.
// Fires an LLM call after the first turn to produce a short, descriptive title.
// Fire-and-forget — never blocks the reply pipeline.

import { resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
import { patchSessionEntryWithKey } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";

const AUTO_TITLE_PROMPT = `You are a conversation title generator. Generate a short, descriptive title (max 60 characters) for this conversation based on the user's message and the assistant's response. The title should capture the main topic or intent. Use the user's language. Do not include quotes, dates, or extra text. Only output the title.`;

const AUTO_TITLE_MAX_LENGTH = 60;

export type AutoTitleParams = {
  userMessage: string;
  assistantReply: string;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  storePath: string;
  entry?: SessionEntry;
  /** Callback to notify the UI that the title changed. */
  onTitleGenerated?: (title: string) => void;
};

/**
 * Determines whether auto-title generation should run for this session.
 * Only runs on the first turn (systemSent is falsy).
 */
export function shouldGenerateAutoTitle(entry?: SessionEntry): boolean {
  // Only on first turn — systemSent is set to true after the first reply
  if (entry?.systemSent) {
    return false;
  }
  // Skip if already has an LLM title (shouldn't happen on first turn, but defensive)
  if (entry?.llmTitle) {
    return false;
  }
  return true;
}

/**
 * Generates an LLM-based title for the session and writes it to the session entry.
 * Fire-and-forget — returns a promise but callers should not await it.
 */
export async function generateAutoTitle(params: AutoTitleParams): Promise<void> {
  const { userMessage, assistantReply, cfg, agentId, sessionKey, storePath } = params;

  const userSnippet = (userMessage ?? "").slice(0, 300).trim();
  const replySnippet = (assistantReply ?? "").slice(0, 500).trim();

  if (!userSnippet) {
    return;
  }

  // Build the combined message for the LLM
  const combinedMessage = replySnippet
    ? `User: ${userSnippet}\nAssistant: ${replySnippet}`
    : `User: ${userSnippet}`;

  const agentDir = agentId ? resolveAgentDir(cfg, agentId) : resolveDefaultAgentDir(cfg);

  try {
    const title = await generateConversationLabel({
      userMessage: combinedMessage,
      prompt: AUTO_TITLE_PROMPT,
      cfg,
      agentId,
      agentDir,
      maxLength: AUTO_TITLE_MAX_LENGTH,
    });

    if (!title || title.trim().length === 0) {
      logVerbose("auto-title: LLM returned empty title");
      return;
    }

    const trimmedTitle = title.trim();

    // Write to session entry using the store API. patchSessionEntryWithKey
    // returns the entry even when update() declines, so track application
    // separately to keep the original only-fires-when-written semantics.
    let applied = false;
    const updated = await patchSessionEntryWithKey({
      storePath,
      sessionKey,
      update: (entry) => {
        // Only set if not already set (race guard)
        if (entry.llmTitle) {
          return null;
        }
        applied = true;
        return { llmTitle: trimmedTitle };
      },
    });

    if (updated && applied) {
      logVerbose(`auto-title: generated title "${trimmedTitle}" for ${sessionKey}`);
      params.onTitleGenerated?.(trimmedTitle);
    }
  } catch (err) {
    logVerbose(`auto-title: failed: ${String(err)}`);
  }
}
