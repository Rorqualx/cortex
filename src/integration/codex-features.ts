/**
 * Integration adapters for newly built modules.
 *
 * This module provides the thin glue between the exec-policy, sandboxing,
 * project-config, collaboration-modes, and attestation modules and the
 * existing OpenClaw infrastructure. Each export maps to a specific
 * integration point.
 *
 * Integration Points:
 * ─────────────────────────────────────────────────────────────────────
 * 1. Exec Policy → bash-tools.exec-host-gateway.ts::processGatewayAllowlist()
 *    WIRED: import + early policy check before allowlist evaluation.
 *
 * 2. OS Sandboxing → bash-tools.exec-runtime.ts::runExecProcess()
 *    WIRED: import + Seatbelt wrapping for non-Docker host exec.
 *
 * 3. Project Config → config/io.ts or agent-loop session init
 *    READY: Call loadProjectConfigFromCwd() during session startup.
 *
 * 4. Collaboration Modes → agents config resolution
 *    READY: Call resolveCollaborationModeConfig() when mode is specified.
 *
 * 5. Attestation → embedded-agent-runner/run.ts (model response pipeline)
 *    READY: Call createAttestationForResponse() after each model response.
 *    Hook into sessions_spawn for chain-of-custody tracking.
 * ─────────────────────────────────────────────────────────────────────
 */

import {
  getCollaborationModeProfile,
  parseCollaborationMode,
  collaborationModeToConfigOverrides,
} from "../agents/collaboration-modes.js";
import type { CollaborationMode } from "../agents/collaboration-modes.js";
import {
  resolveAttestationConfig as resolveAttestationConfigInternal,
  createAttestationForResponse,
  DEFAULT_ATTESTATION_CONFIG,
} from "../attestation/integration.js";
import type { AttestationConfig, AttestationRecord } from "../attestation/types.js";
import {
  discoverProjectRoot,
  loadProjectConfig,
  clearCache as clearProjectConfigCache,
} from "../config/project-config.js";
import type { ProjectConfigResult } from "../config/project-config.js";
import { evaluatePolicy, loadPolicy } from "../exec-policy/index.js";
import type { PolicyEvaluation, ExecPolicy } from "../exec-policy/index.js";
import {
  buildDefaultOsSandboxConfig,
  shouldApplyOsSandbox,
  wrapWithSeatbelt,
} from "../sandbox/os-sandbox.js";
import type { OsSandboxConfig } from "../sandbox/os-sandbox.js";

// Re-export for convenience
export {
  evaluatePolicy,
  loadPolicy,
  buildDefaultOsSandboxConfig,
  shouldApplyOsSandbox,
  discoverProjectRoot,
  loadProjectConfig,
  parseCollaborationMode,
  collaborationModeToConfigOverrides,
  createAttestationForResponse,
  DEFAULT_ATTESTATION_CONFIG,
};

// ---------------------------------------------------------------------------
// 3. Project Config Integration
// ---------------------------------------------------------------------------

/**
 * Load project-level config overlay for a given working directory.
 *
 * Call this during session startup, after the global config is loaded.
 * Merge the result onto the global config (project values win).
 *
 * Returns null if no project config found.
 */
export function loadProjectConfigFromCwd(
  cwd: string,
  globalConfig: Record<string, unknown>,
): ProjectConfigResult | null {
  const projectRoot = discoverProjectRoot(cwd);
  if (!projectRoot) {
    return null;
  }
  return loadProjectConfig(projectRoot, globalConfig);
}

// ---------------------------------------------------------------------------
// 4. Collaboration Mode Integration
// ---------------------------------------------------------------------------

/**
 * Resolve collaboration mode from config and return config overrides.
 *
 * Call this when resolving the effective agent config.
 * The mode can come from:
 *   - agents.defaults.collaborationMode in config
 *   - A CLI flag / API parameter
 *   - A project config override
 */
export function resolveCollaborationModeConfig(
  modeInput: string | undefined,
): Record<string, unknown> | null {
  if (!modeInput) {
    return null;
  }
  const mode = parseCollaborationMode(modeInput);
  if (!mode) {
    return null;
  }
  return collaborationModeToConfigOverrides(mode);
}

// ---------------------------------------------------------------------------
// 5. Attestation Integration
// ---------------------------------------------------------------------------

/**
 * Resolve attestation config from the openclaw.json config object.
 *
 * Call this during session startup to determine if attestation is enabled.
 * The config is read from `config.attestation` in openclaw.json.
 */
export function resolveAttestationConfig(rawConfig?: Record<string, unknown>): AttestationConfig {
  const attestationRaw = rawConfig?.attestation as Partial<AttestationConfig> | undefined;
  return resolveAttestationConfigInternal(attestationRaw);
}

/**
 * Create an attestation record for a model response (convenience wrapper).
 *
 * Call this in the model response pipeline after each provider response.
 * Returns null if attestation is disabled.
 */
export function attestModelResponse(params: {
  config: AttestationConfig;
  provider: string;
  model: string;
  sessionId: string;
  turnId: string;
  requestPayload: unknown;
  responseContent: string;
  gatewayVersion: string;
  responseHeaders?: Record<string, string>;
  agentId?: string;
  parentReceiptId?: string | null;
  toolCalls?: string[];
  modelOverrides?: string[];
  durationMs?: number;
}): AttestationRecord | null {
  return createAttestationForResponse(params);
}
