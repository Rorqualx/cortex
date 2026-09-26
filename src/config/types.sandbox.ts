// Defines sandbox execution configuration types.
import type { z } from "zod";
import type { AgentSandboxSchema } from "./zod-schema.agent-runtime.js";
import type {
  SandboxBrowserSchema,
  SandboxDockerSchema,
  SandboxPruneSchema,
} from "./zod-schema.sandbox.js";

export type SandboxDockerSettings = NonNullable<z.output<typeof SandboxDockerSchema>>;

export type SandboxBrowserSettings = NonNullable<z.input<typeof SandboxBrowserSchema>> & {
  /** @deprecated Doctor-only legacy input. */
  enableNoVnc?: boolean;
};

export type SandboxPruneSettings = NonNullable<z.input<typeof SandboxPruneSchema>>;

type AgentSandboxConfig = NonNullable<z.input<typeof AgentSandboxSchema>>;

export type SandboxSshSettings = NonNullable<AgentSandboxConfig["ssh"]>;

/** OS-level sandbox settings (Seatbelt on macOS, bwrap on Linux).
 *
 * Applied to host exec when Docker/SSH sandbox is not used.
 * Disabled by default — opt-in for defense in depth.
 */
export type OsSandboxSettings = {
  /** Enable OS-level sandboxing for host exec. Default: false. */
  enabled?: boolean;
  /** Extra absolute paths to allow writes to (beyond workspace + TMPDIR). */
  extraWritableRoots?: string[];
  /** Extra metadata filenames to protect from writes (beyond defaults like .env, .git). */
  extraProtectedMetadata?: string[];
  /** Network policy override. Default: "allow-loopback". */
  network?: "deny" | "allow" | "allow-loopback";
};
