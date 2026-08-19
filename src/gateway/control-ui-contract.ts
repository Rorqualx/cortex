// Stable Control UI contract barrel for Gateway callers. Browser code imports
// narrow browser-safe modules directly so lazy route owners stay out of startup.
export * from "./control-ui-bootstrap-contract.js";
export * from "./control-ui-plugin-frame-contract.js";
export * from "./control-ui-resource-routes.js";
export * from "./control-ui-root-assets.js";
export * from "./control-ui-user-avatar-route.js";

/** Targeted pushed PR snapshot event for subscribed Control UI connections. */
export const CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT =
  "controlUi.sessionPullRequests.changed";

/** Maximum session keys retained by one Control UI PR subscription. */
export const CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS = 200;

/** Public GitHub metadata rendered by Control UI link hover cards. */
export type ControlUiGitHubPreview = {
  additions?: number;
  avatarDataUrl?: string;
  changedFiles?: number;
  closedAt?: string;
  comments?: number;
  createdAt: string;
  deletions?: number;
  draft?: boolean;
  kind: "issue" | "pull";
  login: string;
  mergedAt?: string;
  number: number;
  owner: string;
  repo: string;
  state: string;
  stateReason?: string;
  title: string;
  updatedAt: string;
};

/** Bounded session metadata rendered by Control UI session-link hover cards. */
export type ControlUiSessionPreview =
  | {
      status: "ok";
      sessionKey: string;
      title?: string;
      derivedTitle?: string;
      agentId: string;
      kind?: string;
      channel?: string;
      updatedAt?: number;
      lastMessagePreview?: string;
      archived?: boolean;
    }
  | { status: "unavailable" };

// Control UI ships inside the gateway dist, so these payloads move in
// lockstep with the server; shapes here are not independently versioned.
/** Check-run rollup for a PR head commit, chip pill + CI monitoring popover. */
type ControlUiSessionPullRequestChecks = {
  state: "pending" | "passing" | "failing";
  passed: number;
  failed: number;
  skipped: number;
  /** Queued/in-progress runs plus stale conclusions GitHub invalidated. */
  running: number;
};

/** One GitHub pull request whose head is the session's working branch. */
export type ControlUiSessionPullRequest = {
  number: number;
  owner: string;
  repo: string;
  branch: string;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** Latest check-run rollup for the head commit; absent when no checks ran. */
  checks?: ControlUiSessionPullRequestChecks;
  checksUrl?: string;
};

/**
 * The session's working branch, resolved from local git only so the pre-PR
 * "Create PR" row keeps rendering while the GitHub quota is exhausted.
 */
export type ControlUiSessionBranch = {
  owner: string;
  repo: string;
  branch: string;
  /** Working-tree diff vs the merge base with the remote default branch. */
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /**
   * GitHub "open a pull request for this branch" page. Absent while the
   * branch is unpushed or has nothing to compare — the row then only reports
   * the session's local changed files.
   */
  createUrl?: string;
};

/** Pull requests detected for a session's git branch, chip row payload. */
export type ControlUiSessionPullRequests = {
  pullRequests: ControlUiSessionPullRequest[];
  /**
   * Present when the session's non-default GitHub branch has a creatable PR
   * on origin or local changed files in the working tree.
   */
  branch?: ControlUiSessionBranch;
  /** GitHub quota exhausted; entries may be stale until the limit resets. */
  rateLimited: boolean;
};

/** Per-session pushed state; unavailable snapshots preserve prior UI state. */
export type ControlUiSessionPullRequestSnapshot = ControlUiSessionPullRequests & {
  status: "ready" | "rate-limited" | "unavailable";
};

/** Targeted delta event for sessions watched by one Control UI connection. */
export type ControlUiSessionPullRequestsChanged = {
  sessions: Record<string, ControlUiSessionPullRequestSnapshot>;
};

/** Runtime config consumed by the browser Control UI during bootstrap. */
export type ControlUiBootstrapConfig = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string;
  assistantAvatarSource?: string | null;
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason?: string | null;
  assistantAgentId?: string;
  serverVersion?: string;
  /**
   * Git branch of a source-checkout (non-release) gateway install. Omitted for
   * package installs and mainline (main/master) checkouts so the UI only flags
   * gateways running unreleased branch code.
   */
  devGitBranch?: string;
  localMediaPreviewRoots?: string[];
  embedSandbox?: ControlUiEmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  seamColor?: string;
  /** Resolved `agents.defaults.timeFormat`; "auto" keeps the browser locale default. */
  timeFormat?: "auto" | "12" | "24";
  /** Fork: `gateway.controlUi.chatMessageMaxWidth` CSS width cap for chat bubbles. */
  chatMessageMaxWidth?: string;
  /**
   * Whether the operator terminal surface is enabled (`gateway.terminal.enabled`).
   * The Control UI hides the terminal entirely when false so a disabled kill
   * switch removes the surface rather than showing a button that errors on open.
   */
  terminalEnabled?: boolean;
  /** Whether the Labs-gated CLI agents model-picker group is enabled. */
  cliAgentsEnabled?: boolean;
  pluginFrameGrants?: ControlUiPluginFrameGrantAck[];
};
