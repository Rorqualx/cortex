// Deepseek plugin module implements stream behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  type DeepSeekV4ReasoningEffort,
  type DeepSeekV4ThinkingLevel,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isDeepSeekV4ModelRef } from "./models.js";

// api.deepseek.com accepts the full reasoning_effort enum {low,medium,high,xhigh,
// max} (verified live), so pass the level through instead of collapsing to
// high/max. "minimal" folds to "low" (not in DeepSeek's enum); off/none are
// handled upstream as thinking.disabled. Kept plugin-local so the shared default
// stays conservative for other consumers on unverified backends.
function resolveDeepSeekReasoningEffort(
  thinkingLevel: DeepSeekV4ThinkingLevel,
): DeepSeekV4ReasoningEffort {
  switch (thinkingLevel) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return "high";
  }
}

export function createDeepSeekV4ThinkingWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  return createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel,
    shouldPatchModel: isDeepSeekV4ModelRef,
    resolveReasoningEffort: resolveDeepSeekReasoningEffort,
  });
}
