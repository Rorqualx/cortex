import type { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import type { FailoverReason } from "../../agents/failover/signal.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { TypingSignaler } from "./typing-mode.js";

/** One attempted runtime fallback candidate and its failure reason. */
export type RuntimeFallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason: FailoverReason;
  status?: number;
  code?: string;
};

/** Internal fallback-cycle result before caller-facing settlement projection. */
export type AgentTurnInternalResult =
  | {
      kind: "completed";
      result: Awaited<ReturnType<typeof runEmbeddedAgent>>;
      fallbackProvider?: string;
      fallbackModel?: string;
      fallbackExhausted?: true;
      fallbackAttempts: RuntimeFallbackAttempt[];
      didLogHeartbeatStrip: boolean;
      autoCompactionCount: number;
      /** Payload keys sent directly (not via pipeline) during tool flush. */
      directlySentBlockKeys?: Set<string>;
      /** Payloads successfully sent directly during tool flush. */
      directlySentBlockPayloads?: ReplyPayload[];
      /** Prepared terminal failure, appended only after delivery evidence settles. */
      terminalFailurePayload?: ReplyPayload;
    }
  | {
      kind: "final";
      payload: ReplyPayload;
      resolved?: { provider: string; model: string };
    };

export type SettledAgentTurn = {
  kind: "settled";
  status: "ok" | "failed";
  abortReason?: "user" | "restart";
  result: Awaited<ReturnType<typeof runEmbeddedAgent>>;
  resolved: { provider: string; model: string };
  fallback: { exhausted: boolean; attempts: RuntimeFallbackAttempt[] };
  autoCompactionCount: number;
  didLogHeartbeatStrip: boolean;
  directlySentBlockKeys?: Set<string>;
  directlySentBlockPayloads?: ReplyPayload[];
  terminalFailurePayload?: ReplyPayload;
};

/** Closed result shared by foreground and queued agent-turn callers. */
export type AgentTurnExecutionResult = {
  runId: string;
  outcome:
    | SettledAgentTurn
    | { kind: "aborted"; reason: "user" | "restart" }
    | {
        kind: "rejected";
        payload: ReplyPayload;
        resolved?: { provider: string; model: string };
      };
};

/** Inputs shared by direct and queued agent-turn execution. */
export type AgentTurnParams = {
  commandBody: string;
  transcriptCommandBody?: string;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
  replyThreading?: TemplateContext["ReplyThreading"];
  replyOperation?: ReplyOperation;
  opts?: InternalGetReplyOptions;
  resolveVisibleReplyDelivery?: () => Promise<boolean>;
  typingSignals: TypingSignaler;
  blockReplyPipeline: BlockReplyPipeline | null;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  pendingToolTasks: Set<Promise<void>>;
  resetSessionAfterRoleOrderingConflict: (reason: string) => Promise<boolean>;
  /**
   * Confirms the replacement writer owns restart recovery after this session's
   * transcript writer claim was rebound to it (see isSessionLeaseLoss in
   * agent-runner-error-handler.ts). Not yet wired by any caller; optional so
   * the lease-loss branch stays a no-op until a producer confirms ownership
   * against the latest persisted claim/terminal marker.
   */
  isHeartbeat: boolean;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  getActiveSessionEntry: () => SessionEntry | undefined;
  activeSessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
  toolProgressDetail?: "explain" | "raw";
  replyMediaContext?: ReplyMediaContext;
  onCompactionNoticePayload?: (payload: ReplyPayload) => Promise<void> | void;
  isRestartRecoveryArmed?: () => boolean;
};

export type EmbeddedAgentRunResult = Awaited<ReturnType<typeof runEmbeddedAgent>>;
