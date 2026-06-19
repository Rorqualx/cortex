// Control UI module implements sidebar content behavior.
export type SidebarFullMessageRequest = {
  sessionKey: string;
  agentId?: string;
  messageId: string;
  kind: "assistant_message" | "user_message" | "tool_output";
};

export type MarkdownSidebarContent = {
  kind: "markdown";
  content: string;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: "not_found" | "oversized" | "not_visible" | null;
};

export type CanvasSidebarContent = {
  kind: "canvas";
  docId: string;
  title?: string;
  entryUrl: string;
  preferredHeight?: number;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: "not_found" | "oversized" | "not_visible" | null;
};

export type ImageSidebarContent = {
  kind: "image";
  title: string;
  src: string;
  mimeType?: string | null;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: "not_found" | "oversized" | "not_visible" | null;
};

export type PendingEdit = {
  type: "edit" | "apply_patch";
  /** Line-based hunks: removed lines and added lines */
  removed: string[];
  added: string[];
  /** 0-based line index where oldText was found in file content (for inline placement) */
  matchLineIndex?: number;
};

export type CodeSidebarContent = {
  kind: "code";
  fileName: string;
  content: string;
  language: string;
  rawText?: string | null;
  reading?: boolean;
  editing?: boolean;
  pendingEdit?: PendingEdit | null;
  // Kept in sync with the other sidebar variants so the SidebarContent union
  // exposes these uniformly (indexed access + raw-content passthrough).
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: "not_found" | "oversized" | "not_visible" | null;
};

export type SidebarContent =
  | MarkdownSidebarContent
  | CanvasSidebarContent
  | ImageSidebarContent
  | CodeSidebarContent;
