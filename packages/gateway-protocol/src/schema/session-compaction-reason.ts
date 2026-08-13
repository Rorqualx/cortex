import { Type } from "typebox";

// Leaf module (typebox-only, no back-edges) so both sessions.ts and the fork-only
// session-row.ts import the value from here instead of session-row.ts pulling it out
// of sessions.ts. That cross-module value edge produced a bundler TDZ
// ("Cannot access 'SessionCompactionCheckpointReasonSchema' before initialization")
// once sessions.ts gained the sessions-recover import and the emit order shifted.
// Upstream keeps this local to sessions.ts; the fork needs it cross-module, so a leaf
// is the stable owner.

/** Reason a compaction checkpoint was created. */
export const SessionCompactionCheckpointReasonSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("auto-threshold"),
  Type.Literal("overflow-retry"),
  Type.Literal("timeout-retry"),
]);
