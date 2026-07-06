// Runs the configured deterministic quality check as a bounded subprocess.
import type { ResolvedGuardrailsConfig } from "./config.js";
import type { CommandRunner } from "./gating.js";

const MAX_SUMMARY_CHARS = 4_000;

export type QualityCheckOutcome =
  | { status: "pass" }
  // Fail-open: infra failure (spawn error, timeout, killed) must never block delivery.
  | { status: "skip"; reason: string }
  | { status: "fail"; summary: string };

function tailSummary(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  return combined.length > MAX_SUMMARY_CHARS ? combined.slice(-MAX_SUMMARY_CHARS) : combined;
}

/**
 * Runs `command + extraArgs` in `cwd` with the configured env (merged over the
 * process env by the runtime, so CI=1 forces local lanes without dropping PATH).
 * A clean non-zero exit is a real failure; any non-`exit` termination is treated
 * as skip (fail-open).
 */
export async function runQualityCheck(
  runCommand: CommandRunner,
  cwd: string,
  cfg: ResolvedGuardrailsConfig["qualityCheck"],
): Promise<QualityCheckOutcome> {
  const argv = [...cfg.command, ...cfg.extraArgs];
  let result;
  try {
    result = await runCommand(argv, { cwd, timeoutMs: cfg.timeoutMs, env: cfg.env });
  } catch (err) {
    return { status: "skip", reason: `quality check failed to spawn: ${String(err)}` };
  }
  if (result.termination !== "exit") {
    return { status: "skip", reason: `quality check did not exit cleanly (${result.termination})` };
  }
  if (result.code === 0) {
    return { status: "pass" };
  }
  return { status: "fail", summary: tailSummary(result.stdout, result.stderr) };
}
