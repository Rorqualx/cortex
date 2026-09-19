import { classifyFailoverReasonCore, classifyFailoverSignalCore } from "./classify-core.js";
import {
  classifyProviderPluginError,
  type PreparedProviderFailoverOwner,
} from "./provider-patterns.js";
import type { FailoverClassification, FailoverReason, FailoverSignal } from "./signal.js";
import { extractLeadingHttpStatus } from "../../shared/assistant-error-format.js";
export { isCloudCodeAssistFormatError } from "./classify-core.js";
export { isUnclassifiedNoBodyHttpSignal } from "./classification-rules.js";

/**
 * Fork: boolean form of the transient-HTTP rule for the whole-turn retry gate in
 * auto-reply/reply/agent-runner-error-handler.ts (via embedded-agent-helpers).
 * Mirrors classifyFailoverClassificationFromHttpStatus, which treats 499 and every
 * 5xx as retryable (timeout/overloaded/server_error) since upstream retired the
 * per-code TRANSIENT_HTTP_ERROR_CODES set.
 */
export function isTransientHttpError(raw: string): boolean {
  const status = extractLeadingHttpStatus(raw.trim());
  return status != null && (status.code === 499 || (status.code >= 500 && status.code < 600));
}
export { isContextOverflowError, isLikelyContextOverflowError } from "./context-overflow.js";
export {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isProviderCompletedErrorFinishReasonMessage,
  isProviderRequestSizeCeilingError,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./message-patterns.js";
export { extractFailoverSignalDetails } from "./signal-details.js";

export function classifyFailoverSignal(
  signal: FailoverSignal,
  opts?: { providerPlugin?: PreparedProviderFailoverOwner | null },
): FailoverClassification | null {
  return classifyFailoverSignalCore(signal, (context) =>
    classifyProviderPluginError({ ...context, providerPlugin: opts?.providerPlugin }),
  );
}

export function classifyFailoverReason(
  raw: string,
  opts?: { provider?: string; providerPlugin?: PreparedProviderFailoverOwner | null },
): FailoverReason | null {
  return classifyFailoverReasonCore(raw, opts, (context) =>
    classifyProviderPluginError({ ...context, providerPlugin: opts?.providerPlugin }),
  );
}

export function isFailoverErrorMessage(raw: string, opts?: { provider?: string }): boolean {
  return classifyFailoverReason(raw, opts) !== null;
}
