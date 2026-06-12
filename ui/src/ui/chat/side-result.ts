// Control UI chat module implements side result behavior.
import type { ChatSideResultEvent } from "../../../../packages/gateway-protocol/src/index.js";
import { normalizeOptionalString } from "../string-coerce.ts";

// Parsed projection of ChatSideResultEventSchema: seq is consumed at the gateway
// layer and isError is defaulted to false by the parser below.
export type ChatSideResult = Omit<ChatSideResultEvent, "seq" | "isError"> & {
  isError: boolean;
};

export function parseChatSideResult(payload: unknown): ChatSideResult | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  if (candidate.kind !== "btw") {
    return null;
  }
  const runId = normalizeOptionalString(candidate.runId);
  const sessionKey = normalizeOptionalString(candidate.sessionKey);
  const question = normalizeOptionalString(candidate.question);
  const text = normalizeOptionalString(candidate.text);
  if (!(runId && sessionKey && question && text)) {
    return null;
  }
  return {
    kind: "btw",
    runId,
    sessionKey,
    ...(normalizeOptionalString(candidate.agentId)
      ? { agentId: normalizeOptionalString(candidate.agentId) }
      : {}),
    question,
    text,
    isError: candidate.isError === true,
    ts:
      typeof candidate.ts === "number" && Number.isFinite(candidate.ts) ? candidate.ts : Date.now(),
  };
}
