import type {
  SessionTranscriptRuntimeScope,
  SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";

/** Fork alias kept for tool-result-truncation and fork runtime consumers. */
export type RuntimeTranscriptScope = SessionTranscriptRuntimeScope;

/**
 * Resolves the runtime transcript target for read/probe operations without
 * linking missing file-backed metadata into the session store.
 */
export async function resolveRuntimeTranscriptReadTarget(
  scope: SessionTranscriptRuntimeScope,
): Promise<SessionTranscriptRuntimeTarget> {
  const target = await resolveSessionTranscriptRuntimeTarget(scope);
  const { restoreSessionColdTranscript } =
    await import("../../config/sessions/session-cold-storage.js");
  await restoreSessionColdTranscript({ ...target, ...(scope.env ? { env: scope.env } : {}) });
  return target;
}
