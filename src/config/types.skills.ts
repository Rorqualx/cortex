/**
 * Skill-related config types for discovery, installation, limits, and per-skill overrides.
 * Secret-bearing skill options use SecretInput so config redaction and secret refs stay consistent.
 */
import type { SecretInput } from "./types.secrets.js";

/** Per-skill runtime override keyed by skill name or source-specific skill key. */
export type SkillConfig = {
  /** Disable a discovered skill without removing it from disk. */
  enabled?: boolean;
  /** Optional secret made available to the skill runtime through skill env handling. */
  apiKey?: SecretInput;
  /** Plain environment overrides applied when the skill runs. */
  env?: Record<string, string>;
  /** Skill-specific structured config consumed by the skill runtime. */
  config?: Record<string, unknown>;
};

/** Discovery and watcher settings for skill sources. */
export type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
  /**
   * Real target directories that skill symlinks may resolve into even when they
   * sit outside the configured source root.
   */
  allowSymlinkTargets?: string[];
  /** Watch skill folders for changes and refresh the skills snapshot. */
  watch?: boolean;
};

/** Skill installation preferences and upload policy. */
export type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
  /** Allow gateway clients to install zip archives staged through skills.upload.*. */
  allowUploadedArchives?: boolean;
};

/** Limits that bound skill discovery and model-facing prompt expansion. */
export type SkillsLimitsConfig = {
  /** Max number of immediate child directories to consider under a skills root before treating it as suspicious. */
  maxCandidatesPerRoot?: number;
  /** Max number of skills to load per skills source (bundled/managed/workspace/extra). */
  maxSkillsLoadedPerSource?: number;
  /** Max number of skills to include in the model-facing skills prompt. */
  maxSkillsInPrompt?: number;
  /** Max characters for the model-facing skills prompt block (approx). */
  maxSkillsPromptChars?: number;
  /** Max size (bytes) allowed for a SKILL.md file to be considered. */
  maxSkillFileBytes?: number;
};

/** Autonomous learning mode: "auto" lets agents save and update Workshop skills; "off" disables it. */
export type SkillsWorkshopAutonomousMode = "off" | "auto";

/**
 * Skill Forge config. Hosts the fork's promote/retire pipeline settings plus upstream's
 * Skill Workshop autonomous-learning settings, which the fork reads from `skills.forge`
 * (see resolveSkillWorkshopConfig) instead of upstream's `skills.workshop`.
 */
export type SkillsForgeConfig = {
  /** Whether skill_forge promote/retire actions need explicit approval. */
  approvalPolicy?: "pending" | "auto";
  /**
   * Auto-invoke promoted recovery skills on matching tool errors: inline the
   * skill's guidance into the failed tool result and record usage so the decay
   * sweep keeps it. Default on; set false to disable the runtime nudge without
   * unloading the skills.
   */
  autoInvoke?: boolean;
  /** Autonomous Skill Workshop learning. */
  autonomous?: {
    mode?: SkillsWorkshopAutonomousMode;
    /** Post background review notices to supported channels. Default: false. */
    channelNotices?: boolean;
  };
  /** Maximum Workshop skill file size in bytes. */
  maxSkillBytes?: number;
};

/** Upstream name for the Workshop settings shape; in the fork it is the `skills.forge` block. */
export type SkillsWorkshopConfig = SkillsForgeConfig;

/** Top-level skills config block in openclaw config. */
export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  limits?: SkillsLimitsConfig;
  /**
   * Skill Forge + Workshop settings. `skills.workshop` is a retired key: strict validation
   * rejects it and the doctor migration rewrites it here, so it is deliberately not typed.
   */
  forge?: SkillsForgeConfig;
  entries?: Record<string, SkillConfig>;
};
