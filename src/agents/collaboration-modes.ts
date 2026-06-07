/**
 * Collaboration Mode Templates.
 *
 * Named presets that bundle exec security, tool access, and behavior
 * into a single human-selectable mode. Inspired by Codex's CollaborationMode
 * (ask, plan, code) but adapted to OpenClaw's existing exec mode system.
 *
 * Modes:
 *   - "ask"     — Read-only analysis, no execution. Safe for exploration.
 *   - "plan"    — Propose changes, no auto-apply. User approves each action.
 *   - "code"    — Full autonomous coding with sandboxed execution.
 *   - "full"    — Unrestricted access (no sandbox, no approval prompts).
 */
import type { ExecMode } from "../infra/exec-approvals.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CollaborationMode = "ask" | "plan" | "code" | "full";

export interface CollaborationModeProfile {
  /** Human-readable name. */
  label: string;
  /** Short description of what this mode allows. */
  description: string;
  /** The exec mode to use. */
  execMode: ExecMode;
  /** Whether sandboxing should be active (when available). */
  sandboxEnabled: boolean;
  /** Tools to deny in this mode (regardless of other settings). */
  deniedTools: string[];
  /** System prompt guidance for the agent's behavior in this mode. */
  behaviorGuidance: string;
}

// ---------------------------------------------------------------------------
// Mode Presets
// ---------------------------------------------------------------------------

const MODE_PROFILES: Record<CollaborationMode, CollaborationModeProfile> = {
  ask: {
    label: "Ask",
    description:
      "Read-only analysis. The agent can read files and search the web, but cannot execute commands or write files.",
    execMode: "deny",
    sandboxEnabled: false,
    deniedTools: ["exec", "write", "edit", "apply_patch", "bash"],
    behaviorGuidance:
      "You are in ASK mode. Do not execute commands or modify files. Only read, search, and analyze. Provide your analysis and recommendations without making changes.",
  },
  plan: {
    label: "Plan",
    description:
      "Propose changes without applying them. The agent can read and analyze, but must ask before executing or writing.",
    execMode: "ask",
    sandboxEnabled: true,
    deniedTools: ["exec"],
    behaviorGuidance:
      "You are in PLAN mode. You may read files and propose changes, but you must get explicit user approval before executing commands or writing files. Present your plan clearly and wait for confirmation.",
  },
  code: {
    label: "Code",
    description:
      "Autonomous coding with sandboxed execution. The agent can execute commands and write files within the sandbox.",
    execMode: "auto",
    sandboxEnabled: true,
    deniedTools: [],
    behaviorGuidance:
      "You are in CODE mode. You have full autonomy to execute commands and modify files within the project. Sandbox protection is active. Work efficiently and verify your changes.",
  },
  full: {
    label: "Full",
    description: "Unrestricted access. No sandbox, no approval prompts. Use with caution.",
    execMode: "full",
    sandboxEnabled: false,
    deniedTools: [],
    behaviorGuidance:
      "You are in FULL mode. You have unrestricted access to the system. No sandbox or approval requirements. Be careful and verify destructive operations.",
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the profile for a collaboration mode.
 * Returns the "code" profile as default for unknown modes.
 */
export function getCollaborationModeProfile(mode: CollaborationMode): CollaborationModeProfile {
  return MODE_PROFILES[mode] ?? MODE_PROFILES.code;
}

/**
 * Get all available collaboration mode names.
 */
export function getAvailableModes(): CollaborationMode[] {
  return Object.keys(MODE_PROFILES) as CollaborationMode[];
}

/**
 * Resolve a collaboration mode from a string (case-insensitive).
 * Returns null if the string doesn't match any mode.
 */
export function parseCollaborationMode(input: string): CollaborationMode | null {
  const normalized = input.toLowerCase().trim();
  if (normalized in MODE_PROFILES) {
    return normalized as CollaborationMode;
  }
  return null;
}

/**
 * Merge a collaboration mode profile into agent config overrides.
 * Returns a partial config object that can be deep-merged onto the agent config.
 */
export function collaborationModeToConfigOverrides(
  mode: CollaborationMode,
): Record<string, unknown> {
  const profile = getCollaborationModeProfile(mode);
  return {
    agents: {
      defaults: {
        execMode: profile.execMode,
        sandbox: {
          mode: profile.sandboxEnabled ? "non-main" : "off",
        },
        tools: {
          deny: profile.deniedTools.length > 0 ? profile.deniedTools : undefined,
        },
      },
    },
  };
}
