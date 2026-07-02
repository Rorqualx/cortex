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
  /** Unique tool call id — keys the one-shot scroll sweep; content-derived
   * keys collide when two calls apply identical diff text. */
  callId: string;
};

export type CodeSidebarContent = {
  kind: "code";
  fileName: string;
  /** Absolute path of the displayed content: the server-canonical path for
   * fetched reads, or the tool arg resolved against the agent's workspace root
   * for write auto-opens (the agent's tool cwd is that root). Same-file checks
   * key on it (fileName alone collides across directories), and it is also the
   * exact refetch recipe — `path.resolve()` of an absolute path is itself, so a
   * refetch is cwd-independent. Absent only when no workspace root is known yet
   * to resolve a relative arg (pre files-list window). */
  path?: string;
  /** Agent the content belongs to — a refetch during an edit hold must query
   * it even if the user switched chats, since reads resolve against the
   * owning agent's workspace. */
  agentId: string;
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
