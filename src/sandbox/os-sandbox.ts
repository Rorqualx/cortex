import { isSeatbeltAvailable, buildDefaultSeatbeltConfig } from "./seatbelt/index.js";
/**
 * OS-level sandbox detection and configuration.
 *
 * Exports platform detection helpers and the `shouldApplyOsSandbox` gate
 * that the exec-runtime uses to decide whether to wrap host commands.
 */
import type { OsSandboxConfig, SeatbeltConfig } from "./seatbelt/types.js";

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
 * Resolved OS sandbox config from the sandbox config resolver.
 */
export interface ResolvedOsSandbox {
  enabled: boolean;
  extraWritableRoots: string[];
  extraProtectedMetadata: string[];
  network: "deny" | "allow" | "allow-loopback";
}

/**
 * Build a SeatbeltConfig that merges the base defaults with user-provided overrides.
 *
 * - Adds `extraWritableRoots` as additional writable roots
 * - Adds `extraProtectedMetadata` to the deny list
 * - Overrides the network policy if specified
 */
export function buildSeatbeltConfigWithOverrides(
  workspaceDir: string,
  overrides: ResolvedOsSandbox,
): SeatbeltConfig {
  const base = buildDefaultSeatbeltConfig(workspaceDir);

  return {
    ...base,
    writableRoots: [
      ...base.writableRoots,
      ...overrides.extraWritableRoots.map((p) => ({ path: p, access: "write" as const })),
    ],
    protectedMetadata: [...base.protectedMetadata, ...overrides.extraProtectedMetadata],
    network: overrides.network,
  };
}

/**
 * Resolve whether OS sandboxing should be applied.
 *
 * Uses the resolved SandboxConfig to determine:
 * 1. Is OS sandboxing explicitly enabled in config?
 * 2. Is the current platform supported?
 * 3. Is this a Docker exec? (never double-sandbox)
 *
 * Default: DISABLED. Must be explicitly enabled via `sandbox.osSandbox.enabled: true`.
 */
export function shouldApplyOsSandbox(
  osSandboxConfig: ResolvedOsSandbox | undefined,
  isDockerExec?: boolean,
): boolean {
  // Never sandbox commands already running inside Docker
  if (isDockerExec) return false;

  // Check explicit config
  if (!osSandboxConfig?.enabled) return false;

  // Platform support check
  return isOsSandboxAvailable();
}
