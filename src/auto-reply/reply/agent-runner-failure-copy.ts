// Centralizes user-facing failure copy for external agent runner errors.
export const GENERIC_EXTERNAL_RUN_FAILURE_TEXT =
  "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";

export const HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT =
  "⚠️ Heartbeat check failed before it could produce an update. The main chat session remains available.";

// Shown when a follow-up arrives while a prior turn still holds the session
// write lock (e.g. mid tool-call). The active turn owns the transcript, so the
// follow-up can't run concurrently — tell the user it's still working rather
// than surfacing the raw lock-timeout diagnostic.
export const SESSION_BUSY_WITH_ACTIVE_RUN_TEXT =
  "⏳ Still finishing your previous message — I can't start this one until the current turn wraps up. Send it again in a moment and I'll pick it up.";

/** True when text is exactly the generic external run failure copy. */
function isGenericExternalRunFailureText(text: string | undefined): boolean {
  return text?.trim() === GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
}

/** Replaces trailing generic failure text with heartbeat-specific copy. */
export function replaceGenericExternalRunFailureText(text: string): {
  text: string;
  replaced: boolean;
} {
  if (isGenericExternalRunFailureText(text)) {
    return { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, replaced: true };
  }

  const genericStart = text.indexOf(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
  if (genericStart < 0) {
    return { text, replaced: false };
  }

  const trailing = text.slice(genericStart + GENERIC_EXTERNAL_RUN_FAILURE_TEXT.length).trim();
  if (trailing) {
    return { text, replaced: false };
  }

  const prefix = text.slice(0, genericStart).trimEnd();
  return {
    text: prefix
      ? `${prefix} ${HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT}`
      : HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
    replaced: true,
  };
}
