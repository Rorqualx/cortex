/**
 * Secret-use approver that prompts through the existing plugin-approval pipeline.
 *
 * Reuses `plugin.approval.request` / `plugin.approval.waitDecision` so the prompt
 * appears in the Control UI approval modal AND any bound native channel, with no
 * new protocol/gateway/UI surface. Fails closed ("deny") on no route, timeout,
 * run cancellation, or gateway error.
 */
import { callGatewayTool } from "./gateway.js";
import type { SecretApprover, SecretUseDecision } from "./http-request.js";

const APPROVAL_TIMEOUT_MS = 5 * 60_000;
// Buffer the RPC beyond the approval window so the gateway can clean up and
// respond before the client-side timeout fires.
const GATEWAY_RPC_BUFFER_MS = 15_000;

/** Requester identity + originating channel so the prompt routes to the right surface. */
export type SecretApprovalRequesterContext = {
  agentId?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

function parseDecision(value: unknown): SecretUseDecision | null {
  return value === "allow-once" || value === "allow-always" || value === "deny" ? value : null;
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Build a SecretApprover that prompts the user via the plugin-approval pipeline. */
export function createGatewaySecretApprover(ctx: SecretApprovalRequesterContext): SecretApprover {
  return async ({ name, host, signal }) => {
    const requestParams = {
      // Core vault prompt — not a plugin. pluginId is display metadata only.
      pluginId: null,
      title: `Use saved credential "${name}"`,
      description: `The agent wants to authenticate a request to ${host} using your saved "${name}" credential.`,
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      toolName: "http_request",
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      ...(ctx.turnSourceChannel ? { turnSourceChannel: ctx.turnSourceChannel } : {}),
      ...(ctx.turnSourceTo ? { turnSourceTo: ctx.turnSourceTo } : {}),
      ...(ctx.turnSourceAccountId ? { turnSourceAccountId: ctx.turnSourceAccountId } : {}),
      ...(ctx.turnSourceThreadId !== undefined
        ? { turnSourceThreadId: ctx.turnSourceThreadId }
        : {}),
      timeoutMs: APPROVAL_TIMEOUT_MS,
      twoPhase: true,
    };
    try {
      const requestResult = await callGatewayTool<{ id?: string; decision?: string | null }>(
        "plugin.approval.request",
        { timeoutMs: APPROVAL_TIMEOUT_MS + GATEWAY_RPC_BUFFER_MS },
        requestParams,
        { expectFinal: false },
      );
      const id = requestResult?.id;
      if (!id) {
        return "deny";
      }
      // Two-phase: the gateway may resolve immediately (standing route policy),
      // otherwise we wait for the reviewer decision.
      if (Object.hasOwn(requestResult ?? {}, "decision")) {
        return parseDecision(requestResult?.decision) ?? "deny";
      }
      const waitPromise = callGatewayTool<{ decision?: string | null }>(
        "plugin.approval.waitDecision",
        { timeoutMs: APPROVAL_TIMEOUT_MS + GATEWAY_RPC_BUFFER_MS },
        { id },
      );
      const waitResult = signal ? await raceAbort(waitPromise, signal) : await waitPromise;
      return parseDecision(waitResult?.decision) ?? "deny";
    } catch {
      // No approval route, gateway error, or run aborted — fail closed.
      return "deny";
    }
  };
}
