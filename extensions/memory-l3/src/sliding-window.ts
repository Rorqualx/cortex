import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { estimateMessageTokens } from "./token-estimate.js";

export type SlidingWindowSelection = {
  selected: AgentMessage[];
  estimatedTokens: number;
};

/**
 * Select the contiguous tail of messages whose total estimated token count
 * fits within the given budget. The most recent message is always included
 * (even if it exceeds the budget by itself), and the head is walked back over
 * orphan tool-result messages so the model never sees a tool result without
 * its calling assistant message.
 */
export function selectSlidingWindow(params: {
  messages: ReadonlyArray<AgentMessage>;
  tokenBudget: number;
}): SlidingWindowSelection {
  const { messages, tokenBudget } = params;
  if (messages.length === 0 || tokenBudget <= 0) {
    return { selected: [], estimatedTokens: 0 };
  }

  let total = 0;
  let firstIdx = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) {
      continue;
    }
    const cost = estimateMessageTokens(msg);
    if (firstIdx < messages.length && total + cost > tokenBudget) {
      break;
    }
    total += cost;
    firstIdx = i;
  }

  while (firstIdx > 0) {
    const current = messages[firstIdx];
    if (!current || !isToolResultMessage(current)) {
      break;
    }
    firstIdx -= 1;
    const prev = messages[firstIdx];
    if (prev) {
      total += estimateMessageTokens(prev);
    }
  }

  return {
    selected: messages.slice(firstIdx),
    estimatedTokens: total,
  };
}

function isToolResultMessage(message: AgentMessage): boolean {
  return (message as { role?: string }).role === "toolResult";
}
