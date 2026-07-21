// Z.AI public policy surface shared by cold selection and the provider runtime.
// Single source for the reasoning_effort gate + ladder so the profile core
// offers during cold selection cannot drift from what the runtime forwards.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

// Ordered reasoning_effort ladder the modern GLM API accepts (verified live via
// the 400 enum: none|minimal|low|medium|high|xhigh|max). "none"/"off" are sent as
// thinking.disabled, so the selectable ladder starts at minimal.
export const ZAI_REASONING_EFFORT_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

// reasoning_effort is a GLM-family param accepted across every SKU shape tested
// live — base, turbo, and vision — of the glm-4.6/4.7/5 generation. Gated to that
// generation; "flash"/"flashx" were unreachable to confirm and glm-4.5* predates
// it, so both stay on the binary toggle rather than risk a 400.
export function supportsZaiReasoningEffort(modelId?: string | null): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  const modernFamily =
    lower.startsWith("glm-5") || lower.startsWith("glm-4.7") || lower.startsWith("glm-4.6");
  return modernFamily && !lower.includes("flash");
}

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile {
  if (supportsZaiReasoningEffort(ctx.modelId)) {
    return {
      // "off" covers reasoning_effort:none via thinking.disabled.
      levels: [
        { id: "off", label: "off" },
        ...ZAI_REASONING_EFFORT_LEVELS.map((id) => ({ id, label: id })),
      ],
      defaultLevel: "off",
    };
  }
  return {
    levels: [
      { id: "off", label: "off" },
      { id: "low", label: "on" },
    ],
    defaultLevel: "off",
  };
}
