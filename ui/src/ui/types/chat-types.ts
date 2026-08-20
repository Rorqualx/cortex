/**
 * Chat message types for the UI layer.
 */
import type { SenderIdentity } from "../chat/sender-label.ts";

/**
 * A branch point from the chat.branches RPC — one transcript entry with more
 * than one child conversation. Mirrors SessionBranchPoint in
 * src/gateway/server-methods/chat-branch.ts; both must stay in sync.
 */
export interface SessionBranchPoint {
  entryId: string;
  parentId: string | null;
  childCount: number;
  /** Child entry IDs in transcript order — the order the navigator cycles. */
  childIds: string[];
  /** The child on the active branch path, or null when off it. */
  activeChildId: string | null;
  isActive: boolean;
  isLeaf: boolean;
  label?: string;
  timestamp: string;
  type: string;
}

/** Union type for items in the chat thread */
export type ChatItem =
  | { kind: "message"; key: string; message: unknown; duplicateCount?: number }
  | {
      kind: "divider";
      key: string;
      label: string;
      description?: string;
      /** Optional trailing stat rendered next to the label (e.g. compaction savings). */
      metric?: string;
      action?: { kind: "session-checkpoints"; label: string };
      timestamp: number;
    }
  | {
      kind: "branch-point";
      key: string;
      entryId: string;
      childCount: number;
      activeChildIndex: number;
      label?: string;
      timestamp: number;
    }
  | { kind: "stream"; key: string; text: string; startedAt: number; isStreaming: boolean }
  | {
      kind: "thinking";
      key: string;
      text: string;
      startedAt: number;
      isStreaming: boolean;
    }
  | { kind: "reading-indicator"; key: string };

/** A group of consecutive messages from the same role (Slack-style layout) */
export type MessageGroup = {
  kind: "group";
  key: string;
  role: string;
  senderLabel?: string | null;
  messages: Array<{ message: unknown; key: string; duplicateCount?: number }>;
  timestamp: number;
  isStreaming: boolean;
};

/** Content item types in a normalized message */
export type MessageContentItem =
  | {
      type: "text" | "tool_call" | "tool_result";
      text?: string;
      name?: string;
      args?: unknown;
    }
  | {
      type: "thinking";
      text: string;
      isStreaming?: boolean;
    }
  | {
      type: "attachment";
      attachment: {
        url: string;
        kind: "image" | "audio" | "video" | "document";
        label: string;
        mimeType?: string;
        isVoiceNote?: boolean;
      };
    }
  | {
      type: "canvas";
      preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
      rawText?: string | null;
    };

/** Normalized message structure for rendering */
export type NormalizedMessage = {
  role: string;
  content: MessageContentItem[];
  timestamp: number;
  id?: string;
  senderLabel?: string | null;
  /** Structured author identity (non-display); resolves the avatar gutter. */
  sender?: SenderIdentity | null;
  audioAsVoice?: boolean;
  replyTarget?:
    | {
        kind: "current";
      }
    | {
        kind: "id";
        id: string;
      }
    | null;
};

/** Tool card representation for inline tool call/result rendering */
export type ToolCard = {
  id: string;
  name: string;
  args?: unknown;
  inputText?: string;
  outputText?: string;
  isError?: boolean;
  /** Set once the tool's result arrives (a call-only card stays undefined). */
  completed?: boolean;
  messageId?: string;
  preview?: {
    kind: "canvas";
    // node_panel is upstream's second canvas surface; mirror CanvasSurface in src/chat/canvas-render.ts.
    surface: "assistant_message" | "node_panel";
    render: "url";
    title?: string;
    preferredHeight?: number;
    url?: string;
    viewId?: string;
    className?: string;
    style?: string;
    // Fork canvas extensions: sandbox mode override, dashboard-pin name, and MCP
    // app view metadata carried through from the tool preview payload.
    sandbox?: "strict" | "scripts";
    boardWidgetName?: string;
    mcpApp?: {
      viewId: string;
      serverName?: string;
      toolName?: string;
      uiResourceUri?: string;
      toolCallId?: string;
      originSessionKey?: string;
    };
  };
};
