// Builds Claude Code CLI argv for a single delegated turn and enforces task-mode
// workspace safety. Mirrors the stream-json contract of core's
// `src/agents/cli-runner/claude-live-session.ts` (buildClaudeLiveArgs) but for
// per-turn `-p --resume` delegation rather than a held-open live session.
import os from "node:os";
import path from "node:path";

export type SessionMode = "task" | "research";

// Read-only research preset: Claude Code may inspect the repo and the web but
// cannot mutate the filesystem or run shell commands.
export const RESEARCH_ALLOWED_TOOLS = "Read Grep Glob WebSearch WebFetch";
export const RESEARCH_DISALLOWED_TOOLS = "Write Edit Bash";

/** Builds argv for one delegated turn. Omit `resumeId` for the first turn. */
export function buildClaudeTurnArgs(params: { mode: SessionMode; resumeId?: string }): string[] {
  // `-p` + stream-json + `--verbose` is the supported non-interactive structured
  // protocol; `--verbose` is required by the CLI when printing stream-json.
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (params.resumeId) {
    args.push("--resume", params.resumeId);
  }
  if (params.mode === "task") {
    // Auto-accept edits so the delegated worker can write/run without prompting;
    // scoped to the session cwd by the spawn working directory.
    args.push("--permission-mode", "acceptEdits");
  } else {
    args.push(
      "--permission-mode",
      "default",
      "--allowedTools",
      RESEARCH_ALLOWED_TOOLS,
      "--disallowedTools",
      RESEARCH_DISALLOWED_TOOLS,
    );
  }
  return args;
}

/**
 * Refuses task-mode sessions rooted in OpenClaw state dirs, where a delegated
 * agent with write/exec access could corrupt live state. Mirrors the safety
 * rule in `skills/coding-agent/SKILL.md`.
 */
export function assertTaskCwdAllowed(cwd: string): void {
  const resolved = path.resolve(cwd);
  const home = os.homedir();
  const stateDir = process.env.OPENCLAW_STATE_DIR
    ? path.resolve(process.env.OPENCLAW_STATE_DIR)
    : path.join(home, ".openclaw");
  const isInside = resolved === stateDir || resolved.startsWith(stateDir + path.sep);
  if (isInside) {
    throw new Error(
      `claude-connect: task mode cannot run inside ${stateDir}; choose a separate workspace (cwd).`,
    );
  }
}
