import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SEATBELT_BASE_POLICY } from "./base-policy.js";
import type {
  SeatbeltConfig,
  SeatbeltWrappedCommand,
  SandboxRoot,
  ProtectedMetadataName,
} from "./types.js";

/** Path to the macOS sandbox-exec binary. Only trust /usr/bin (Codex's security model). */
const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Escape a string for embedding in an SBPL string literal.
 * SBPL uses C-style escaping with backslash.
 */
function escapeSbplString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a filesystem access rule for a set of roots.
 * Generates `(allow file-read* ...)` or `(allow file-write* ...)` with parameterized paths.
 *
 * For writable roots, protected metadata names are excluded using `require-not` rules.
 */
/** Sanitize a filesystem action name for use as a parameter key (no special chars). */
function actionToParamPrefix(action: string): string {
  return action.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function buildFilesystemPolicy(
  action: string,
  roots: SandboxRoot[],
  protectedNames: ProtectedMetadataName[],
  params: Map<string, string>,
): string {
  if (roots.length === 0) {
    return "";
  }

  const prefix = actionToParamPrefix(action);
  const parts: string[] = [];

  for (const [i, root] of roots.entries()) {
    const normalizedPath = path.resolve(root.path);
    // Resolve symlinks — Seatbelt operates on real paths, not symlinks
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(normalizedPath);
    } catch {
      resolvedPath = normalizedPath; // fallback if path doesn't exist yet
    }
    const paramKey = `${prefix}_ROOT_${i}`;
    params.set(paramKey, resolvedPath);

    // Build the base: allow access to subpath of root
    if (root.excluded && root.excluded.length > 0) {
      // Has explicit exclusions
      const requireParts: string[] = [`(subpath (param "${paramKey}"))`];
      for (const [j, excluded] of root.excluded.entries()) {
        const excludedPath = path.resolve(normalizedPath, excluded);
        let resolvedExcluded: string;
        try {
          resolvedExcluded = fs.realpathSync(excludedPath);
        } catch {
          resolvedExcluded = excludedPath;
        }
        const excludedKey = `${prefix}_ROOT_${i}_EXCLUDED_${j}`;
        params.set(excludedKey, resolvedExcluded);
        requireParts.push(`(require-not (literal (param "${excludedKey}")))`);
        requireParts.push(`(require-not (subpath (param "${excludedKey}")))`);
      }
      parts.push(`(require-all ${requireParts.join(" ")} )`);
    } else {
      parts.push(`(subpath (param "${paramKey}"))`);
    }
  }

  // For writable roots, also add protected metadata exclusions
  const metadataDenyRules: string[] = [];
  if (action === "file-write*" && protectedNames.length > 0) {
    // We can't easily exclude metadata names from all writable roots with
    // a single SBPL rule, so we add deny rules using regex for each
    // protected name within each writable root.
    for (const root of roots) {
      const normalizedPath = path.resolve(root.path);
      // Resolve symlinks for deny rules too
      let resolvedRoot: string;
      try {
        resolvedRoot = fs.realpathSync(normalizedPath);
      } catch {
        resolvedRoot = normalizedPath;
      }
      const escapedRoot = escapeSbplString(resolvedRoot.replace(/\/+$/, ""));
      for (const name of protectedNames) {
        const escapedName = escapeSbplString(name);
        if (normalizedPath === "/") {
          metadataDenyRules.push(`(deny file-write* (regex #"^/${escapedName}(/.*)?$"))`);
        } else {
          metadataDenyRules.push(
            `(deny file-write* (regex #"^${escapedRoot}/${escapedName}(/.*)?$"))`,
          );
        }
      }
    }
  }

  let policy = "";
  if (parts.length > 0) {
    policy = `(allow ${action}\n  ${parts.join("\n  ")}\n)\n`;
  }
  policy += metadataDenyRules.join("\n");
  return policy;
}

/**
 * Build network policy section.
 */
function buildNetworkPolicy(config: SeatbeltConfig): string {
  switch (config.network) {
    case "allow":
      return "\n; === network: allow all ===\n(allow network-outbound)\n(allow network-inbound)\n";

    case "allow-loopback":
      return (
        [
          "\n; === network: allow loopback only ===",
          '(allow network-outbound (remote ip "localhost:*"))',
          '(allow network-inbound (local ip "localhost:*"))',
          ...(config.proxyPorts ?? []).map(
            (port) => `(allow network-outbound (remote ip "localhost:${port}"))`,
          ),
        ].join("\n") + "\n"
      );

    case "deny":
    default:
      return "\n; === network: denied ===\n; (deny default already covers network)\n";
  }
}

/**
 * Build unix domain socket policy.
 */
function buildUnixSocketPolicy(config: SeatbeltConfig): string {
  if (!config.allowUnixSockets) {
    return "";
  }
  return "\n; === unix domain sockets ===\n(allow system-socket (socket-domain AF_UNIX))\n(allow network-bind (local unix-socket))\n(allow network-outbound (remote unix-socket))\n";
}

/**
 * Build a complete Seatbelt SBPL profile from a config.
 *
 * Returns the profile string and a map of parameter names to resolved paths.
 * The parameters are passed to sandbox-exec via -D flags.
 */
export function buildSeatbeltProfile(config: SeatbeltConfig): {
  profile: string;
  params: Map<string, string>;
} {
  const params = new Map<string, string>();

  const sections: string[] = [SEATBELT_BASE_POLICY, "\n; === DYNAMIC FILESYSTEM POLICY ===\n"];

  // Readable roots
  const readPolicy = buildFilesystemPolicy(
    "file-read*",
    config.readableRoots,
    [], // no metadata protection for reads
    params,
  );
  if (readPolicy) {
    sections.push(readPolicy);
  }

  // Writable roots
  const writePolicy = buildFilesystemPolicy(
    "file-write*",
    config.writableRoots,
    config.protectedMetadata,
    params,
  );
  if (writePolicy) {
    sections.push(writePolicy);
  }

  // Network
  sections.push(buildNetworkPolicy(config));

  // Unix sockets
  sections.push(buildUnixSocketPolicy(config));

  return { profile: sections.join("\n"), params };
}

/**
 * Wrap a command with sandbox-exec using a profile file (-f flag).
 *
 * This writes the profile to a temporary file and uses `-f` instead of `-p`
 * to avoid argument-parsing issues with newlines and special characters
 * in the SBPL profile string.
 *
 * @param command - The command to wrap (array of strings).
 * @param config - Seatbelt configuration.
 * @returns The wrapped command and generated profile.
 */
export function wrapWithSeatbelt(
  command: string[],
  config: SeatbeltConfig,
): SeatbeltWrappedCommand {
  const { profile, params } = buildSeatbeltProfile(config);

  // Write profile to a temp file (more robust than -p for multiline SBPL)
  const profileHash = crypto.createHash("sha256").update(profile).digest("hex").slice(0, 12);
  const profileFile = path.join(os.tmpdir(), `openclaw-sandbox-${profileHash}.sbpl`);
  fs.writeFileSync(profileFile, profile, { mode: 0o600 });

  // Build the -D parameter flags
  const paramFlags: string[] = [];
  for (const [key, value] of params) {
    paramFlags.push("-D", `${key}=${value}`);
  }

  // sandbox-exec -D KEY=VALUE ... -f <profile-file> -- <command>
  const fullCommand: string[] = [
    MACOS_SANDBOX_EXEC,
    ...paramFlags,
    "-f",
    profileFile,
    "--",
    ...command,
  ];

  return { command: fullCommand, profile };
}

/**
 * Build a default SeatbeltConfig for a workspace directory.
 *
 * This is the standard configuration:
 * - Workspace: writable (except protected metadata)
 * - System dirs: read-only
 * - TMPDIR: writable
 * - Network: allow-loopback (safe for most dev work)
 * - Protected metadata: .openclaw, .env, .git, credentials, secrets
 */
export function buildDefaultSeatbeltConfig(workspaceDir: string): SeatbeltConfig {
  // Resolve all symlinks — Seatbelt operates on real paths
  let resolvedWorkspace: string;
  try {
    resolvedWorkspace = fs.realpathSync(path.resolve(workspaceDir));
  } catch {
    resolvedWorkspace = path.resolve(workspaceDir);
  }
  let resolvedTmpdir: string;
  try {
    resolvedTmpdir = fs.realpathSync(os.tmpdir());
  } catch {
    resolvedTmpdir = os.tmpdir();
  }

  return {
    writableRoots: [
      { path: resolvedWorkspace, access: "write" },
      { path: resolvedTmpdir, access: "write" },
    ],
    readableRoots: [
      // System paths (read-only)
      { path: "/usr", access: "read" },
      { path: "/System", access: "read" },
      { path: "/Library", access: "read" },
      { path: "/opt", access: "read" },
      // Home directory for dotfiles/toolchains (read-only)
      { path: path.resolve(os.homedir()), access: "read" },
      // Workspace is also readable (always)
      { path: resolvedWorkspace, access: "read" },
      // Tmpdir is also readable
      { path: resolvedTmpdir, access: "read" },
      // Standard dev paths
      { path: "/dev", access: "read" },
      { path: "/etc", access: "read" },
      { path: "/var", access: "read" },
      { path: "/tmp", access: "read" },
      // Private dirs (Homebrew on Apple Silicon, nix, etc.)
      { path: "/private", access: "read" },
    ],
    protectedMetadata: [
      ".openclaw",
      ".env",
      ".env.local",
      ".env.production",
      ".git",
      "credentials",
      "secrets",
      ".credentials",
      ".secrets",
      "id_rsa",
      "id_ed25519",
      "id_ecdsa",
    ],
    network: "allow-loopback",
    allowUnixSockets: true,
  };
}

/**
 * Check if macOS Seatbelt sandboxing is available on this system.
 */
export function isSeatbeltAvailable(): boolean {
  return process.platform === "darwin";
}
