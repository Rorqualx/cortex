/**
 * Faithfulness gate run at agent finalize.
 *
 * Grounds the final assistant answer against the conversation's authoritative
 * material — the user's messages and tool results, NOT the model's own prior
 * assertions (those are claims, not sources). An `ungrounded` verdict maps to a
 * `revise` decision the caller feeds into the existing before-finalize revision
 * limiter; everything else (`grounded`, `skipped`, short answers, no source)
 * delivers as-is. The gate never blocks delivery directly.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logDebug } from "../../logger.js";
import { recordGroundingCheck } from "./metrics-store.js";
import {
  verifyGrounding,
  type GroundingVerdict,
  type GroundingVerifierConfig,
} from "./verifier.js";

/** Below this length an answer is treated as conversational and not checked. */
const MIN_CHECKED_ANSWER_CHARS = 200;
const MAX_REVISION_CLAIMS = 8;

export type GroundingFinalizeDecision =
  | { action: "continue" }
  | { action: "revise"; reason: string };

const CONTINUE: GroundingFinalizeDecision = { action: "continue" };

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Collect every text fragment in a message content payload (string or blocks). */
function extractAllText(content: unknown): string {
  const inline = readString(content);
  if (inline !== undefined) {
    return inline;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = readString((block as { text?: unknown }).text);
    if (text !== undefined) {
      parts.push(text);
      continue;
    }
    // Tool results nest their payload one level deeper.
    const nested = (block as { content?: unknown }).content;
    const nestedText = extractAllText(nested);
    if (nestedText) {
      parts.push(nestedText);
    }
  }
  return parts.join("\n");
}

/**
 * Render the grounding source from transcript messages: user + tool-result
 * content only. Assistant turns are excluded so the answer is never checked
 * against the model's own earlier claims.
 */
export function renderMessagesAsGroundingSource(messages: readonly unknown[]): string {
  const blocks: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = readString((message as { role?: unknown }).role);
    if (role === "assistant") {
      continue;
    }
    const text = extractAllText((message as { content?: unknown }).content).trim();
    if (text) {
      blocks.push(role ? `[${role}] ${text}` : text);
    }
  }
  return blocks.join("\n\n");
}

function buildGroundingRevisionReason(
  verdict: Extract<GroundingVerdict, { status: "ungrounded" }>,
): string {
  const claims = verdict.unsupported.slice(0, MAX_REVISION_CLAIMS);
  const list = claims.length > 0 ? claims.map((c) => `- ${c}`).join("\n") : `- ${verdict.reason}`;
  return [
    "A grounding check found claims in your previous answer that are not supported",
    "by the conversation or tool results:",
    list,
    "",
    "Revise your answer to include only information supported by the available",
    "context. State uncertainty explicitly instead of asserting unverified facts.",
    "Do not fabricate sources or details.",
  ].join("\n");
}

/**
 * Verify the final answer against the transcript source. Returns `revise` only
 * when the verifier is confident the answer is ungrounded; all other outcomes
 * (including verifier fail-open `skipped`) continue to delivery.
 */
export async function runGroundingFinalizeGate(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  finalAnswer: string;
  messages: readonly unknown[];
  config?: GroundingVerifierConfig;
  signal?: AbortSignal;
  deps?: {
    verifyGrounding?: typeof verifyGrounding;
    recordGroundingCheck?: typeof recordGroundingCheck;
  };
}): Promise<GroundingFinalizeDecision> {
  const answer = params.finalAnswer.trim();
  if (answer.length < MIN_CHECKED_ANSWER_CHARS) {
    return CONTINUE;
  }
  const source = renderMessagesAsGroundingSource(params.messages);
  if (!source.trim()) {
    return CONTINUE;
  }
  const verify = params.deps?.verifyGrounding ?? verifyGrounding;
  const verdict = await verify({
    cfg: params.cfg,
    agentId: params.agentId,
    source,
    claims: answer,
    config: params.config,
    signal: params.signal,
  });
  const willRevise = verdict.status === "ungrounded";
  recordCheck(params.agentId, verdict, willRevise, params.deps?.recordGroundingCheck);
  if (willRevise) {
    return { action: "revise", reason: buildGroundingRevisionReason(verdict) };
  }
  return CONTINUE;
}

/** Record the check; a metrics-write fault must never break delivery. */
function recordCheck(
  agentId: string,
  verdict: GroundingVerdict,
  revised: boolean,
  record: typeof recordGroundingCheck = recordGroundingCheck,
): void {
  try {
    record({
      agentId,
      outcome: verdict.status,
      revised,
      preConfidence: verdict.preConfidence,
      postConfidence: verdict.postConfidence,
    });
  } catch (err) {
    logDebug(`grounding: metrics record failed: ${String(err)}`);
  }
}
