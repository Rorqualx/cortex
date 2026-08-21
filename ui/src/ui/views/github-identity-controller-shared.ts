import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ToolsGitHubAuthorizeStartResult, ToolsGitHubStatusResult } from "../types.ts";

export type GitHubIdentityScope = "system" | "agent";
export type GitHubIdentityDraft = { token: string; name: string; email: string };

export type RequestOwner = {
  client: GatewayBrowserClient;
  agentId: string;
  clientRevision: number;
  agentRevision: number;
  requestRevision: number;
};

// The fork's runtime-config capability does not expose upstream's write-coordinator
// `runExternalMutation`. The github-identity flow only needs the mutation contract
// (serialize an RPC against config writes, then report the config refresh outcome),
// so it is declared locally and the host supplies a matching implementation.
export type GitHubExternalMutationOptions = {
  waitForWritesResumed?: boolean;
  canDispatch?: () => boolean;
  dispatchError?: string;
};

export type GitHubExternalMutationResult<T> =
  | {
      ok: true;
      value: T;
      refresh: { ok: true } | { ok: false; error: string };
    }
  | {
      ok: false;
      reason: "conflict" | "error" | "rejected" | "suspended" | "unavailable";
      error: string;
    };

export type RunGitHubExternalMutation = <T>(
  task: (client: GatewayBrowserClient) => Promise<T>,
  options?: GitHubExternalMutationOptions,
) => Promise<GitHubExternalMutationResult<T>>;

type AuthorizationPresentation = ToolsGitHubAuthorizeStartResult & {
  phase: "code" | "pending" | "network_error" | "cancelling" | "finishing" | "cancel_error";
  displayExpiresAtMs: number;
  slowedDown?: boolean;
  message?: string;
};

export type GitHubAuthorizationState =
  | { phase: "idle" }
  | { phase: "starting" | "cancelling" }
  | AuthorizationPresentation
  | {
      phase: "access_denied" | "expired" | "incorrect_device_code" | "failed";
      message?: string;
    };

export type AuthorizationOperation = {
  owner: RequestOwner;
  scope: GitHubIdentityScope;
  controller: AbortController;
  requestId?: string;
  start?: ToolsGitHubAuthorizeStartResult;
  displayExpiresAtMs?: number;
  timer?: ReturnType<typeof setTimeout>;
  cancelRequested?: boolean;
  cancelInFlight?: boolean;
  cancelTooLate?: boolean;
  cancelError?: string;
};

export type GitHubIdentityHost = {
  requestUpdate: () => void;
  runExternalMutation: RunGitHubExternalMutation;
};

export type GitHubConfigureMutationResult =
  | {
      ok: true;
      value: ToolsGitHubStatusResult;
      refresh: { ok: true } | { ok: false; error: string };
    }
  | { ok: false; error: string };

export function configFingerprint(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function readGitHubIdentityDraft(value: unknown): GitHubIdentityDraft {
  const github = isRecord(value) ? value : undefined;
  const gitAuthor = isRecord(github?.gitAuthor) ? github.gitAuthor : undefined;
  return {
    token: "",
    name: typeof gitAuthor?.name === "string" ? gitAuthor.name : "",
    email: typeof gitAuthor?.email === "string" ? gitAuthor.email : "",
  };
}

export function cancelAuthorizationRequest(operation: AuthorizationOperation): void {
  if (!operation.requestId) {
    return;
  }
  void operation.owner.client
    .request("tools.github.authorize.cancel", { requestId: operation.requestId })
    .catch(() => undefined);
}
