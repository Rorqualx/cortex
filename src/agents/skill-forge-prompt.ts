/**
 * System-prompt contribution for routing skill-forge pipeline operations
 * through the skill_forge tool.
 */
export const SKILL_FORGE_TOOL_NAME = "skill_forge";

/** Build the system-prompt section for Skill Forge routing rules. */
export function buildSkillForgePromptSection(): string[] {
  return [
    "## Skill Forge",
    "Use `skill_forge` to inspect, capture, run, promote, retire, and query telemetry for the autonomous Skill Forge pipeline.",
    "The pipeline automatically captures sessions, detects repeated patterns, distills them into skill drafts, and promotes them after validation.",
    "Use `action=status` to get an overview of promoted, staged, and retired skills with usage counts.",
    "Use `action=capture` with `session_id` to manually capture a session for forge processing.",
    "Use `action=run` to execute the full pipeline (detect → distill → gate → promote) on captured sessions.",
    "Use `action=promote` with `name` to promote a staged skill to the active skills directory.",
    "Use `action=retire` with `name` and optional `reason` to demote a skill, or omit `name` to run a decay sweep on stale skills.",
    "Use `action=telemetry` to list per-skill usage statistics including use counts and last-used timestamps.",
    "Do not directly modify forge skill files with `write`, `edit`, or `exec`. Use `skill_forge` actions to manage the pipeline.",
    "After promoting or retiring skills, rebuild and restart the gateway so changes take effect: `bash scripts/prod-restart.sh` (auto-daemonizes when called from inside the gateway). Add `--no-build` to skip the build if you already built.",
    "",
  ];
}
