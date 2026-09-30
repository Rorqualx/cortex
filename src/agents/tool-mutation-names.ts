import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  AUTOMATIONS_TOOL_NAME,
  LEGACY_AUTOMATIONS_TOOL_NAMES,
} from "./tools/automations-tool-name.js";

export type FileMutationToolName = "write" | "edit" | "apply_patch";

export function resolveFileMutationToolName(toolName: string): FileMutationToolName | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
  return normalized === "write" || normalized === "edit" || normalized === "apply_patch"
    ? normalized
    : undefined;
}

export function isLikelyMutatingToolName(toolName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
  return Boolean(
    normalized &&
    (MUTATING_TOOL_NAMES.has(normalized) ||
      normalized.endsWith("_actions") ||
      normalized.startsWith("message_") ||
      normalized.includes("send")),
  );
}
