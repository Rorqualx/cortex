// Fast-path delivery of a plain follow-up into an already-active embedded run.
//
// A follow-up that arrives while the session's run is active normally blocks on
// the reply slot (admitReplyTurn waitForActive) until that run fully ends, so
// the message is not consumed until the whole run finishes. For a steer-mode
// turn that is the wrong shape: the message should reach the running agent at
// its next turn boundary, not after the entire run.
//
// This mirrors the shipped `/steer` command (commands-steer.ts) for ordinary
// turns: when there is a live embedded run and the resolved queue mode is
// `steer`, inject the text as a steering message instead of waiting. It is a
// best-effort optimization with a safe fallback — the canonical steer-vs-run
// decision still lives in get-reply-run, and any case this does not handle
// returns false so the caller proceeds to the normal (blocking) dispatch, which
// serializes a fresh run. That blocking fallback is what prevents a follow-up
// from racing a finishing run into a session-takeover.
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isEmbeddedAgentRunHandleActive,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunHandleSessionId,
} from "./commands-steer.runtime.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { resolveQueueSettings } from "./queue/settings-runtime.js";

/**
 * Tries to deliver a plain visible follow-up as a steering message to the
 * session's already-active embedded run. Fire-and-forget (like the shipped
 * `/steer`): the message is enqueued into the live run's durable steering queue
 * and drains at the next turn boundary — there is no commit-wait, so a follow-up
 * never stalls on a busy or finishing run. Returns true when the enqueue is
 * accepted; in every other case (no live run handle, non-steer mode, inline
 * queue/reset directive, runtime rejection) it returns false and the caller MUST
 * fall through to the normal blocking dispatch.
 */
export async function tryFastSteerActiveFollowup(params: {
  sessionKey: string | undefined;
  rawText: string;
  cfg: OpenClawConfig;
  channel: string | undefined;
  sessionEntry: SessionEntry | undefined;
}): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  // Resolve the LIVE embedded run handle's session id (not the reply-operation id,
  // which can differ for the same session). Steering must target the in-memory
  // handle so the message goes straight into the running agent's queue; targeting
  // the reply-op id would route through the session-file write path and collide
  // with the live attempt (session takeover). A session with only a reply operation
  // and no embedded handle (e.g. the pre-dispatch window or between attempts) is not
  // steerable here — return false and let the normal blocking dispatch own it.
  const activeSessionId = resolveActiveEmbeddedRunHandleSessionId(sessionKey);
  if (!activeSessionId || !isEmbeddedAgentRunHandleActive(activeSessionId)) {
    return false;
  }
  const directives = parseInlineDirectives(params.rawText);
  // Inline queue/reset directives change steer-vs-followup semantics; defer to
  // the normal dispatch path rather than guessing the mode here.
  if (directives.hasQueueDirective || directives.queueReset) {
    return false;
  }
  const steerText = directives.cleaned.trim();
  if (!steerText) {
    return false;
  }
  const resolved = resolveQueueSettings({
    cfg: params.cfg,
    channel: params.channel,
    sessionEntry: params.sessionEntry,
  });
  if (resolved.mode !== "steer") {
    return false;
  }
  const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(activeSessionId, steerText, {
    steeringMode: "all",
  }).catch(() => undefined);
  return outcome?.queued === true;
}
