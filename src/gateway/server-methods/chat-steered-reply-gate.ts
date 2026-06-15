// Decides which committed assistant turns of a webchat run must be broadcast as
// out-of-band "final" chat events.
//
// A `chat.send` dispatch awaits the whole run and its delivery path broadcasts the
// run's primary reply to the originating prompt. The same run can then produce
// further terminal replies without a new dispatch — a steered follow-up turn
// injected by a later message — which nothing else surfaces to the client. The
// first terminal assistant reply is the primary (already broadcast); each
// subsequent terminal reply is a steered turn the gateway must broadcast itself.
//
// Intermediate tool-call turns are not user-facing replies and never count.
//
// The gate is stateful per run and lives in the dispatch closure so its count
// survives attempt retries (which happen below that frame).

export type SteeredReplyBroadcastDecision =
  | { kind: "ignore" }
  | { kind: "primary" }
  | { kind: "steered"; followupIndex: number };

/**
 * Returns a stateful classifier for a single webchat run. Call it once per
 * committed model-visible assistant turn, in commit order, passing the turn's
 * stop reason. It returns whether the turn is an intermediate tool-call turn to
 * ignore, the run's primary reply (owned by the dispatch delivery path), or a
 * steered follow-up reply the caller must broadcast (with a per-run follow-up
 * index for a distinct broadcast run id).
 */
export function createSteeredFollowupReplyGate(): (
  stopReason: string | undefined,
) => SteeredReplyBroadcastDecision {
  let terminalRepliesSeen = 0;
  return (stopReason) => {
    if (stopReason === "tool_use") {
      return { kind: "ignore" };
    }
    terminalRepliesSeen += 1;
    if (terminalRepliesSeen <= 1) {
      return { kind: "primary" };
    }
    return { kind: "steered", followupIndex: terminalRepliesSeen - 1 };
  };
}
