import type { AgentMessage } from "@openclaw/agent-core";
import { replaceCompactionReplayOwnerContent } from "@openclaw/ai/transports";
/**
 * Transcript repair helpers for tool-call replay.
 *
 * Normalizes raw tool-call blocks and synthesizes missing tool results without rewriting trusted local payloads.
 */
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import {
  hasNonEmptyString as hasNonEmptyStringField,
  normalizeLowercaseStringOrEmpty,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  classifyToolUseResultPairing,
  makeMissingToolResult as makePairingMissingToolResult,
  normalizeLegacyToolResultId,
} from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { isThinkingLikeBlock } from "./thinking-block.js";
import { extractToolCallsFromAssistant, extractToolResultIds } from "./tool-call-id.js";
import { isAllowedToolCallName, normalizeAllowedToolNames } from "./tool-call-shared.js";

type RawToolCallBlock = {
  type?: unknown;
  id?: unknown;
  call_id?: unknown;
  toolCallId?: unknown;
  toolUseId?: unknown;
  tool_call_id?: unknown;
  tool_use_id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
  partialJson?: unknown;
};

const RAW_TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "toolUse",
  "functionCall",
  "tool_call",
  "tool_use",
  "function_call",
]);

function isRawToolCallBlock(block: unknown): block is RawToolCallBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return typeof type === "string" && RAW_TOOL_CALL_BLOCK_TYPES.has(type);
}

function hasToolCallInput(block: RawToolCallBlock): boolean {
  const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
  const hasArguments =
    "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
  return hasInput || hasArguments;
}

function hasToolCallId(block: RawToolCallBlock): boolean {
  return (
    hasNonEmptyStringField(block.id) ||
    hasNonEmptyStringField(block.call_id) ||
    hasNonEmptyStringField(block.toolCallId) ||
    hasNonEmptyStringField(block.toolUseId) ||
    hasNonEmptyStringField(block.tool_call_id) ||
    hasNonEmptyStringField(block.tool_use_id)
  );
}

function hasPartialJson(
  block: RawToolCallBlock,
): block is RawToolCallBlock & { partialJson: string } {
  return typeof block.partialJson === "string";
}

function isCompleteJsonObject(value: string): boolean {
  return safeParseJsonRecord(value) !== undefined;
}

function isFinalizedOpenAIResponsesToolCall(
  message: AgentMessage,
  block: RawToolCallBlock,
): boolean {
  if (
    message.role !== "assistant" ||
    !("stopReason" in message) ||
    message.stopReason !== "toolUse" ||
    !hasPartialJson(block) ||
    typeof block.id !== "string" ||
    "input" in block ||
    !block.arguments ||
    typeof block.arguments !== "object" ||
    Array.isArray(block.arguments) ||
    (!isCompleteJsonObject(block.partialJson) &&
      (block.partialJson.trim() !== "" || Object.keys(block.arguments).length > 0))
  ) {
    return false;
  }

  const separator = block.id.indexOf("|");
  return separator > 0 && separator < block.id.length - 1;
}

function sanitizeToolCallBlock(block: RawToolCallBlock): RawToolCallBlock {
  // This repair path normalizes replay shape only. Tool payloads are local
  // trusted-operator transcript state per SECURITY.md, so do not redact or
  // rewrite sessions_spawn arguments here.
  const rawName = readStringValue(block.name);
  const trimmedName = rawName?.trim();
  const hasTrimmedName = typeof trimmedName === "string" && trimmedName.length > 0;
  const normalizedName = hasTrimmedName ? trimmedName : undefined;
  const nameChanged = hasTrimmedName && rawName !== trimmedName;

  if (!nameChanged) {
    return block;
  }
  const next = { ...(block as Record<string, unknown>) };
  if (nameChanged && normalizedName) {
    next.name = normalizedName;
  }
  return next as RawToolCallBlock;
}

function countRawToolCallBlocks(content: unknown[]): number {
  let count = 0;
  for (const block of content) {
    if (isRawToolCallBlock(block)) {
      count += 1;
    }
  }
  return count;
}

function isReplaySafeThinkingAssistantTurn(
  content: unknown[],
  allowedToolNames: Set<string> | null,
): boolean {
  let sawToolCall = false;
  const seenToolCallIds = new Set<string>();
  for (const block of content) {
    if (!isRawToolCallBlock(block)) {
      continue;
    }
    sawToolCall = true;
    const toolCallId = typeof block.id === "string" ? block.id.trim() : "";
    if (
      !hasToolCallInput(block) ||
      hasPartialJson(block) ||
      !toolCallId ||
      seenToolCallIds.has(toolCallId) ||
      !isAllowedToolCallName(block.name, allowedToolNames)
    ) {
      return false;
    }
    seenToolCallIds.add(toolCallId);
    if (sanitizeToolCallBlock(block) !== block) {
      return false;
    }
  }
  return sawToolCall;
}

function hasSessionsSpawnAttachmentToolCall(content: unknown[]): boolean {
  for (const block of content) {
    if (!isRawToolCallBlock(block) || block.name !== "sessions_spawn") {
      continue;
    }
    const input = block.input;
    if (!input || typeof input !== "object") {
      continue;
    }
    const attachments = (input as { attachments?: unknown }).attachments;
    if (Array.isArray(attachments) && attachments.length > 0) {
      return true;
    }
  }
  return false;
}

function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
  text?: string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  return makePairingMissingToolResult(params);
}

export { makeMissingToolResult };

type ToolCallInputRepairReport = {
  messages: AgentMessage[];
  droppedToolCalls: number;
  droppedAssistantMessages: number;
};

type ToolCallInputRepairOptions = {
  allowedToolNames?: Iterable<string>;
  allowProviderOwnedThinkingReplay?: boolean;
};

type ErroredAssistantResultPolicy = "preserve" | "drop";

type ToolUseResultPairingOptions = {
  erroredAssistantResultPolicy?: ErroredAssistantResultPolicy;
  missingToolResultText?: string;
  // A valid Responses checkpoint may split a call from its later output.
  // Only that replay owner may retain results that normal repair treats as orphaned.
  preserveUnframedToolResults?: boolean;
};

export function stripToolResultDetails(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || (msg as { role?: unknown }).role !== "toolResult") {
      out.push(msg);
      continue;
    }
    if (!("details" in msg)) {
      out.push(msg);
      continue;
    }
    const sanitized = { ...msg };
    Reflect.deleteProperty(sanitized, "details");
    touched = true;
    out.push(sanitized);
  }
  return touched ? out : messages;
}

function collectFollowingToolResults(
  messages: AgentMessage[],
  index: number,
): { ids: Set<string>; displaced: boolean } {
  const ids = new Set<string>();
  const assistant = messages[index];
  const currentToolCalls =
    assistant && typeof assistant === "object" && assistant.role === "assistant"
      ? extractToolCallsFromAssistant(assistant)
      : [];
  let sawNonToolResult = false;
  let displaced = false;
  for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex += 1) {
    const message = messages[nextIndex];
    if (!message || typeof message !== "object") {
      sawNonToolResult = true;
      continue;
    }
    if (message.role === "assistant" && extractToolCallsFromAssistant(message).length > 0) {
      break;
    }
    if (message.role === "toolResult") {
      const normalizedLegacyResult = normalizeLegacyToolResultId(message, currentToolCalls);
      const resultIds = extractToolResultIds(normalizedLegacyResult);
      for (const id of resultIds) {
        ids.add(id);
      }
      displaced ||= resultIds.length > 0 && sawNonToolResult;
      continue;
    }
    sawNonToolResult = true;
  }
  return { ids, displaced };
}

function repairToolCallInputs(
  messages: AgentMessage[],
  options?: ToolCallInputRepairOptions,
): ToolCallInputRepairReport {
  let droppedToolCalls = 0;
  let droppedAssistantMessages = 0;
  let changed = false;
  const out: AgentMessage[] = [];
  const allowedToolNames = normalizeAllowedToolNames(options?.allowedToolNames);
  const allowProviderOwnedThinkingReplay = options?.allowProviderOwnedThinkingReplay === true;
  const preservedThinkingToolCallIds = new Set<string>();
  const priorToolCallIds = new Set<string>();

  for (const [index, msg] of messages.entries()) {
    if (!msg || typeof msg !== "object") {
      changed = true;
      continue;
    }

    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    if (
      allowProviderOwnedThinkingReplay &&
      msg.content.some((block) => isThinkingLikeBlock(block)) &&
      countRawToolCallBlocks(msg.content) > 0
    ) {
      // Signed Anthropic thinking blocks must remain byte-for-byte stable on
      // replay. Preserve the turn when every sibling tool call is already valid;
      // the later pairing repair can synthesize missing legacy tool results
      // without mutating provider-owned assistant content.
      const replaySafeToolCalls = extractToolCallsFromAssistant(msg);
      const followingToolResults = collectFollowingToolResults(messages, index);
      if (
        isReplaySafeThinkingAssistantTurn(msg.content, allowedToolNames) &&
        replaySafeToolCalls.every(
          (toolCall) =>
            !preservedThinkingToolCallIds.has(toolCall.id) &&
            (!hasSessionsSpawnAttachmentToolCall(msg.content) ||
              followingToolResults.ids.has(toolCall.id)) &&
            (!followingToolResults.displaced || !priorToolCallIds.has(toolCall.id)),
        )
      ) {
        for (const toolCall of replaySafeToolCalls) {
          preservedThinkingToolCallIds.add(toolCall.id);
          priorToolCallIds.add(toolCall.id);
        }
        changed ||= followingToolResults.displaced;
        out.push(msg);
      } else {
        droppedToolCalls += countRawToolCallBlocks(msg.content);
        droppedAssistantMessages += 1;
        changed = true;
      }
      continue;
    }

    const nextContent: typeof msg.content = [];
    let droppedInMessage = 0;
    let messageChanged = false;

    for (const block of msg.content) {
      if (isRawToolCallBlock(block)) {
        // Drop genuinely incomplete streaming artifacts (missing required fields).
        if (
          !hasToolCallInput(block) ||
          !hasToolCallId(block) ||
          !isAllowedToolCallName((block as RawToolCallBlock).name, allowedToolNames)
        ) {
          droppedToolCalls += 1;
          droppedInMessage += 1;
          changed = true;
          messageChanged = true;
          continue;
        }
      }
      let workBlock = block;
      if (isRawToolCallBlock(block) && hasPartialJson(block)) {
        if (!isFinalizedOpenAIResponsesToolCall(msg, block)) {
          droppedToolCalls += 1;
          droppedInMessage += 1;
          changed = true;
          messageChanged = true;
          continue;
        }

        // Legacy generic Responses transport persisted successful toolUse turns
        // with the scratch buffer intact. Strip it only when terminal state and
        // the provider-specific finalized shape both prove completion.
        const stripped = { ...block };
        delete (stripped as RawToolCallBlock & { partialJson?: unknown }).partialJson;
        workBlock = stripped;
        changed = true;
        messageChanged = true;
      }
      if (isRawToolCallBlock(workBlock)) {
        if (RAW_TOOL_CALL_BLOCK_TYPES.has((workBlock as { type?: string }).type ?? "")) {
          // Only sanitize (redact) sessions_spawn blocks; all others are passed through
          // unchanged to preserve provider-specific shapes (e.g. toolUse.input for Anthropic).
          const blockName =
            typeof (workBlock as { name?: unknown }).name === "string"
              ? (workBlock as { name: string }).name.trim()
              : undefined;
          if (normalizeLowercaseStringOrEmpty(blockName) === "sessions_spawn") {
            const sanitized = sanitizeToolCallBlock(workBlock);
            if (sanitized !== workBlock) {
              changed = true;
              messageChanged = true;
            }
            nextContent.push(sanitized as typeof block);
          } else if (typeof (workBlock as { name?: unknown }).name === "string") {
            const rawName = (workBlock as { name: string }).name;
            const trimmedName = rawName.trim();
            if (rawName !== trimmedName && trimmedName) {
              const renamed = { ...(workBlock as object), name: trimmedName } as typeof block;
              nextContent.push(renamed);
              changed = true;
              messageChanged = true;
            } else {
              nextContent.push(workBlock);
            }
          } else {
            nextContent.push(workBlock);
          }
          continue;
        }
      }
      nextContent.push(workBlock);
    }

    if (droppedInMessage > 0) {
      if (nextContent.length === 0) {
        droppedAssistantMessages += 1;
        changed = true;
        continue;
      }
      const nextMessage = replaceCompactionReplayOwnerContent(msg, nextContent);
      for (const toolCall of extractToolCallsFromAssistant(nextMessage)) {
        priorToolCallIds.add(toolCall.id);
      }
      out.push(nextMessage);
      continue;
    }

    if (messageChanged) {
      const nextMessage = replaceCompactionReplayOwnerContent(msg, nextContent);
      for (const toolCall of extractToolCallsFromAssistant(nextMessage)) {
        priorToolCallIds.add(toolCall.id);
      }
      out.push(nextMessage);
      continue;
    }

    for (const toolCall of extractToolCallsFromAssistant(msg)) {
      priorToolCallIds.add(toolCall.id);
    }
    out.push(msg);
  }

  return {
    messages: changed ? out : messages,
    droppedToolCalls,
    droppedAssistantMessages,
  };
}

export function sanitizeToolCallInputs(
  messages: AgentMessage[],
  options?: ToolCallInputRepairOptions,
): AgentMessage[] {
  return repairToolCallInputs(messages, options).messages;
}

export function sanitizeToolUseResultPairing(
  messages: AgentMessage[],
  options?: ToolUseResultPairingOptions,
): AgentMessage[] {
  return repairToolUseResultPairing(messages, options).messages;
}

/** True only for a toolName that `normalizeToolResultName` would leave untouched (trimmed, non-empty). */
function hasCanonicalToolResultName(
  message: Extract<AgentMessage, { role: "toolResult" }>,
): boolean {
  const rawToolName = (message as { toolName?: unknown }).toolName;
  return (
    typeof rawToolName === "string" && rawToolName.length > 0 && rawToolName.trim() === rawToolName
  );
}

/**
 * Cheap O(N) detector for transcripts `repairToolUseResultPairing` would leave
 * content-unchanged, so the hot outbound sanitizer can skip that O(N^2) pass on
 * the canonical shape agent-core produces every tool-call continuation.
 *
 * Conservative by contract: `true` MUST imply the repair changes no content, so
 * it recognizes only the exact no-op shape — each assistant-with-toolcalls turn
 * immediately followed by its results in call order, one per call, every result
 * carrying an id equal to its call id, unseen across the transcript, with a
 * name `normalizeToolResultName` would not rewrite. Anything else (orphans,
 * duplicates, displaced/missing/misordered results, errored/aborted tool turns,
 * results needing legacy-id or name normalization) returns `false` and takes the
 * real repair. Mirrors the no-op conditions of `normalizeLegacyToolResultId`,
 * `normalizeToolResultName`, and the span pairing loop in `repairToolUseResultPairing`.
 */
export function isToolUseResultPairingValid(messages: AgentMessage[]): boolean {
  const seenToolResultIds = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    if (role === "toolResult") {
      // A tool result reached here only if it was not consumed by an assistant
      // span below — i.e. free-floating/displaced, which the repair drops or moves.
      return false;
    }
    if (role !== "assistant") {
      continue;
    }
    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.length === 0) {
      continue;
    }
    const stopReason = (assistant as { stopReason?: unknown }).stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      // Errored/aborted turns take a dedicated repair branch; never fast-path them.
      return false;
    }
    let cursor = index + 1;
    for (const call of toolCalls) {
      const next = messages[cursor];
      if (!next || typeof next !== "object" || (next as { role?: unknown }).role !== "toolResult") {
        return false;
      }
      const result = next as Extract<AgentMessage, { role: "toolResult" }>;
      // Fast-path requires one call answered by exactly one result carrying its id;
      // a batched/multi-id result falls through to the slower, thorough repair path.
      const resultIds = extractToolResultIds(result);
      const resultId = resultIds.length === 1 ? resultIds[0] : undefined;
      if (!resultId || resultId !== call.id || seenToolResultIds.has(resultId)) {
        return false;
      }
      if (!hasCanonicalToolResultName(result)) {
        return false;
      }
      seenToolResultIds.add(resultId);
      cursor += 1;
    }
    // Consumed exactly the matching results; continue after them. A stray result
    // immediately following the span is caught as free-floating on the next pass.
    index = cursor - 1;
  }
  return true;
}

export function sanitizeToolUseResultPairingForModel(
  messages: AgentMessage[],
  isOpenAIResponsesApi: boolean,
): AgentMessage[] {
  return sanitizeToolUseResultPairing(messages, {
    erroredAssistantResultPolicy: "drop",
    // Match upstream Codex history normalization for OpenAI Responses.
    ...(isOpenAIResponsesApi ? { missingToolResultText: "aborted" } : {}),
  });
}

type ToolUseRepairReport = {
  messages: AgentMessage[];
  added: Array<Extract<AgentMessage, { role: "toolResult" }>>;
  droppedDuplicateCount: number;
  droppedOrphanCount: number;
  moved: boolean;
};

function shouldDropErroredAssistantResults(options?: ToolUseResultPairingOptions): boolean {
  return options?.erroredAssistantResultPolicy === "drop";
}

export function repairToolUseResultPairing(
  messages: AgentMessage[],
  options?: ToolUseResultPairingOptions,
): ToolUseRepairReport {
  // Anthropic (and Cloud Code Assist) reject transcripts where assistant tool calls are not
  // immediately followed by matching tool results. Session files can end up with results
  // displaced (e.g. after user turns) or duplicated. Repair by:
  // - moving matching toolResult messages directly after their assistant toolCall turn
  // - inserting synthetic error toolResults for missing ids
  // - dropping duplicate toolResults for the same tool-call occurrence
  // Provider ids are opaque and can legitimately repeat on later assistant turns.
  // KEEP IN SYNC (fork): `isToolUseResultPairingValid` conservatively mirrors the
  // conditions under which this returns its input unchanged so the hot outbound
  // sanitizer can skip it (`true` MUST imply no-op; `false` merely runs the real
  // repair). Any new content-mutating branch here must be reflected there (and
  // covered by the exhaustive generative case in
  // session-transcript-repair.pairing-validity.test.ts) or valid-looking but
  // unrepaired transcripts will ship to strict providers.
  const added: Array<Extract<AgentMessage, { role: "toolResult" }>> = [];
  const preserveUnframed = options?.preserveUnframedToolResults === true;
  const pairing = classifyToolUseResultPairing(messages, {
    preserveUnframedToolResults: preserveUnframed,
  });
  const { frames } = pairing;
  const droppedDuplicateCount = pairing.droppedDuplicateCount;
  let droppedOrphanCount = pairing.droppedOrphanCount;

  const out: AgentMessage[] = [];
  let cursor = 0;
  const pushUnframedRange = (endIndex: number) => {
    for (; cursor < endIndex; cursor += 1) {
      const message = messages[cursor];
      if (!message || typeof message !== "object") {
        continue;
      }
      if (message.role === "toolResult" && !preserveUnframed) {
        droppedOrphanCount += 1;
        continue;
      }
      out.push(message);
    }
  };

  for (const frame of frames) {
    pushUnframedRange(frame.startIndex);
    cursor = frame.endIndex;

    if (!(frame.failed && shouldDropErroredAssistantResults(options))) {
      out.push(frame.assistant);
      for (const occurrence of frame.occurrences) {
        if (occurrence.result) {
          out.push(occurrence.result);
          continue;
        }
        if (frame.failed) {
          continue;
        }
        const missing = makeMissingToolResult({
          toolCallId: occurrence.id,
          toolName: occurrence.name,
          text: options?.missingToolResultText,
        });
        occurrence.result = missing;
        added.push(missing);
        out.push(missing);
      }
    }
    out.push(...frame.remainder);
  }
  pushUnframedRange(messages.length);

  const changed =
    out.length !== messages.length || out.some((message, index) => message !== messages[index]);
  return {
    messages: changed ? out : messages,
    added,
    droppedDuplicateCount,
    droppedOrphanCount,
    moved: changed,
  };
}
