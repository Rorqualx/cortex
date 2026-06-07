/** Filesystem access level for a root path. */
export type AccessLevel = "read" | "write";

/** A root path with an associated access level. */
export interface SandboxRoot {
  /** Absolute path. */
  path: string;
  /** Whether this root is readable or writable. */
  access: AccessLevel;
  /** Subpaths to exclude from the access level (write-protect within writable root). */
  excluded?: string[];
}

/** Network access policy for the sandbox. */
export type NetworkPolicy = "deny" | "allow" | "allow-loopback";

/** Metadata filenames to protect from writes (e.g., ".env", ".git"). */
export type ProtectedMetadataName = string;

/** Configuration for generating a Seatbelt profile. */
export interface SeatbeltConfig {
  /** Paths the sandboxed command can write to. */
  writableRoots: SandboxRoot[];
  /** Paths the sandboxed command can read from. */
  readableRoots: SandboxRoot[];
  /** Metadata filenames to protect from writes even within writable roots. */
  protectedMetadata: ProtectedMetadataName[];
  /** Network access policy. */
  network: NetworkPolicy;
  /** Extra proxy loopback ports to allow (for HTTP/SOCKS proxies). */
  proxyPorts?: number[];
  /** Whether to allow unix domain sockets. */
  allowUnixSockets?: boolean;
}

/** Result of wrapping a command with seatbelt. */
export interface SeatbeltWrappedCommand {
  /** The full command array: ["sandbox-exec", "-p", profile, "--", ...originalCommand] */
  command: string[];
  /** The generated SBPL profile string (for debugging/logging). */
  profile: string;
}

/** Resolved sandbox configuration for the current platform. */
export interface OsSandboxConfig {
  /** Whether OS-level sandboxing is available on this platform. */
  available: boolean;
  /** The sandbox type. */
  type: "seatbelt" | "bubblewrap" | "none";
  /** Seatbelt config if type is "seatbelt". */
  seatbelt?: SeatbeltConfig;
}
