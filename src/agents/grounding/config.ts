/**
 * Resolves whether the opt-in faithfulness grounding check is enabled for an
 * agent. Mirrors `isLocalModelLeanEnabled` (local-model-lean.ts): per-agent
 * `experimental` overrides fall back to `agents.defaults.experimental`.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "../agent-scope-config.js";

function resolveGroundingAgentId(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  const explicit =
    typeof params.agentId === "string" && params.agentId.trim()
      ? normalizeAgentId(params.agentId)
      : undefined;
  if (explicit) {
    return explicit;
  }
  const fromSession = parseAgentSessionKey(params.sessionKey)?.agentId;
  if (fromSession) {
    return normalizeAgentId(fromSession);
  }
  return params.config ? resolveDefaultAgentId(params.config) : undefined;
}

/** True when `experimental.groundingFaithfulness` is enabled for the agent. */
export function isGroundingFaithfulnessEnabled(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): boolean {
  const agentId = resolveGroundingAgentId(params);
  const experimental =
    params.config && agentId
      ? (resolveAgentConfig(params.config, agentId)?.experimental ??
        params.config.agents?.defaults?.experimental)
      : params.config?.agents?.defaults?.experimental;
  return experimental?.groundingFaithfulness ?? false;
}
