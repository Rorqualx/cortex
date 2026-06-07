import { isSeatbeltAvailable, buildDefaultSeatbeltConfig } from "./seatbelt/index.js";
/**
 * OS-level sandbox detection and configuration.
 *
 * Exports platform detection helpers and the `shouldApplyOsSandbox` gate
 * that the exec-runtime uses to decide whether to wrap host commands.
 */
import type { OsSandboxConfig } from "./seatbelt/types.js";

export type { OsSandboxConfig } from "./seatbelt/types.js";
export {
  wrapWithSeatbelt,
  buildDefaultSeatbeltConfig,
  isSeatbeltAvailable,
} from "./seatbelt/index.js";

/**
 * Detect the current platform's sandbox capability.
 */
export function getOsSandboxType(): "seatbelt" | "bubblewrap" | "none" {
  if (process.platform === "darwin") return "seatbelt";
  // Linux: bubblewrap is available if bwrap is installed
  // For now, defer Linux support — return "none" until we add bwrap detection
  return "none";
}

/**
 * Check if OS-level sandboxing is available.
 */
export function isOsSandboxAvailable(): boolean {
  return getOsSandboxType() !== "none";
}

/**
 * Build a default OS sandbox config for the current platform + workspace.
 *
 * Returns null if no OS sandbox is available.
 */
export function buildDefaultOsSandboxConfig(workspaceDir: string): OsSandboxConfig | null {
  const type = getOsSandboxType();
  if (type === "none") {
    return { available: false, type: "none" };
  }

  if (type === "seatbelt") {
    return {
      available: true,
      type: "seatbelt",
      seatbelt: buildDefaultSeatbeltConfig(workspaceDir),
    };
  }

  // bubblewrap: future
  return { available: false, type: "none" };
}

/**
 * Resolve whether OS sandboxing should be applied.
 *
 * Checks: platform support + config enablement.
 *
 * Default: DISABLED. Must be explicitly enabled via sandbox.osSandbox config.
 * The seatbelt profile restricts write paths which blocks bundlers, package
 * managers, and other build tooling from functioning. Once the exec-policy
 * allowlist covers common build tools, this can flip to opt-out.
 */
export function shouldApplyOsSandbox(explicitlyEnabled?: boolean, isDockerExec?: boolean): boolean {
  // Never sandbox commands already running inside Docker
  if (isDockerExec) return false;

  // If explicitly disabled, respect that
  if (explicitlyEnabled === false) return false;

  // If explicitly enabled, check platform support
  if (explicitlyEnabled === true) return isOsSandboxAvailable();

  // Default: OFF until exec-policy allowlist covers build tooling.
  return false;
}
