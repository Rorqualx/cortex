// Shared Gateway session projection types.
// Keeps server methods and Control UI payloads aligned.
import type {
  GatewaySessionRow as WireGatewaySessionRow,
  GatewaySessionsDefaults as WireGatewaySessionsDefaults,
  SessionCompactionCheckpointPreview as WireSessionCompactionCheckpointPreview,
  SessionRunStatus as WireSessionRunStatus,
  SessionsListResult as WireSessionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type {
  GatewayAgentRuntime,
  GatewayAgentRow as SharedGatewayAgentRow,
  SessionsPatchResultBase,
} from "../shared/session-types.js";

// Session list/event payload shapes are wire contracts owned by
// packages/gateway-protocol (GatewaySessionRowSchema and friends); the server
// aliases them so row builders and emit sites typecheck against the schema.
export type GatewaySessionsDefaults = WireGatewaySessionsDefaults;

/** Runtime status surfaced for the latest session run. */
export type SessionRunStatus = WireSessionRunStatus;

export type SessionCompactionCheckpointPreview = WireSessionCompactionCheckpointPreview;

export type GatewaySessionRow = WireGatewaySessionRow;

export type GatewayAgentRow = SharedGatewayAgentRow;

export type SessionPreviewItem = {
  role: "user" | "assistant" | "tool" | "system" | "other";
  text: string;
};

export type SessionsPreviewEntry = {
  key: string;
  status: "ok" | "empty" | "missing" | "error";
  items: SessionPreviewItem[];
};

export type SessionsPreviewResult = {
  ts: number;
  previews: SessionsPreviewEntry[];
};

export type SessionsListResult = WireSessionsListResult;

export type SessionsPatchResult = SessionsPatchResultBase<SessionEntry> & {
  entry: SessionEntry;
  resolved?: {
    modelProvider?: string;
    model?: string;
    agentRuntime?: GatewayAgentRuntime;
  };
};
