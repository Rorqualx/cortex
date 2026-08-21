// GitHub-identity UI error formatting. The fork lacks upstream's lib/format-error
// helpers, so these small equivalents wrap the fork's canonical error formatter and
// tool-detail redactor. Kept local to the github-identity view/controller/mutations.
import { formatErrorMessage } from "@openclaw/normalization-core";
import { redactToolDetail } from "../browser-redact.ts";

export function formatUiError(error: unknown, fallback = ""): string {
  return formatErrorMessage(error, { redact: redactToolDetail }) || fallback;
}

export function formatUiExternalText(value: string | null | undefined, fallback = ""): string {
  const text = value?.trim();
  return text ? redactToolDetail(text) : fallback;
}
