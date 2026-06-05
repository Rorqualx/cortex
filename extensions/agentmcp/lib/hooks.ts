// Lifecycle hooks for the explore ReAct loop. Mirrors the spirit of native
// Claude Code's PreToolUse hook — a user-configured shell command that gates
// each tool call before execution.
//
// Why env-configured instead of reading ~/.claude/settings.json: Anthropic's
// hook schema in settings.json is still evolving, and tying this server to it
// would couple two independently-versioned things. An env var is dead-simple,
// independently testable, and aligns with the MCP_* config pattern.
//
// Configure in ~/.claude/.env.mcp:
//   MCP_EXPLORE_PRETOOL_HOOK=/absolute/path/to/hook.sh   (gates each tool call)
//   MCP_EXPLORE_STOP_HOOK=/absolute/path/to/hook.sh      (notified when loop ends)
//
// PreToolUse contract:
//   stdin:  JSON { "tool_name": "grep", "tool_input": {...}, "iteration": 3 }
//   stdout: JSON { "decision": "allow" | "deny", "reason"?: "..." }
//   non-zero exit: same as { "decision": "deny", "reason": <stderr first line> }
//   timeout (5s): same as deny with reason "hook timeout"
//
// On deny, the model receives the reason as the tool result (so it can adjust
// its strategy) instead of the tool's actual output.
//
// Stop contract (notification only — return value ignored):
//   stdin: JSON {
//     "subtype": "success" | "error_max_turns" | ...,
//     "halt_reason": "stop" | "iter_cap" | ...,
//     "iterations": 5, "tool_calls": 7, "tool_breakdown": [...],
//     "latency_ms": 8400, "model_latency_ms": 8100, "tool_latency_ms": 300,
//     "provider": "zai" | "deepseek" | "kimi",
//     "model": "glm-4.6", "input_tokens": 9214, "output_tokens": 1832,
//     "cache_hit_tokens"?: 1200, "cost_usd"?: 0.0096, "stop_reason"?: "end_turn",
//     "content": "<full final synthesis>"
//   }
//   stdout: ignored. Useful for archival, monitoring, send-to-Slack, etc.
//   timeout (5s): logged to stderr, otherwise silent — never blocks the loop's return.

import { spawn } from "node:child_process";

const HOOK_TIMEOUT_MS = 5000;

export type PreToolHookInput = {
  tool_name: string;
  tool_input: unknown;
  iteration: number;
};

export type PreToolHookDecision = { decision: "allow" } | { decision: "deny"; reason: string };

/**
 * Read the configured pre-tool hook command from env. Returns null when
 * unset, so the loop can short-circuit without paying any cost.
 */
export function getPreToolHookCommand(): string | null {
  const raw = process.env["MCP_EXPLORE_PRETOOL_HOOK"];
  if (!raw || raw.trim() === "") return null;
  return raw.trim();
}

/**
 * Read the configured stop hook command from env. Returns null when unset.
 */
export function getStopHookCommand(): string | null {
  const raw = process.env["MCP_EXPLORE_STOP_HOOK"];
  if (!raw || raw.trim() === "") return null;
  return raw.trim();
}

export type StopHookInput = Record<string, unknown>;

/**
 * Fire the stop hook with the given payload. Stop hook output is ignored —
 * this is a notification, not a gate. Errors and timeouts are logged to
 * stderr but never thrown, so a misconfigured hook can never block the
 * loop's return.
 *
 * Returns the elapsed ms so callers can include it in their own observability.
 */
export async function runStopHook(
  hookCmd: string,
  payload: StopHookInput,
): Promise<{ elapsedMs: number; error?: string }> {
  const started = Date.now();
  const body = JSON.stringify(payload);

  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", hookCmd], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, HOOK_TIMEOUT_MS);

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      const error = `stop hook spawn failed: ${err.message}`;
      process.stderr.write(`[mcp-explore] ${error}\n`);
      resolve({ elapsedMs: Date.now() - started, error });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - started;
      if (timedOut) {
        const error = "stop hook timeout";
        process.stderr.write(`[mcp-explore] ${error}\n`);
        resolve({ elapsedMs, error });
        return;
      }
      if (code !== 0) {
        const firstLine = stderr.split("\n")[0]?.trim() ?? "";
        const error = `stop hook exited ${code}${firstLine ? ": " + firstLine : ""}`;
        process.stderr.write(`[mcp-explore] ${error}\n`);
        resolve({ elapsedMs, error });
        return;
      }
      resolve({ elapsedMs });
    });

    proc.stdin.write(body);
    proc.stdin.end();
  });
}

/**
 * Invoke the configured pre-tool hook. The command is spawned with `sh -c`
 * so users can pass an inline expression (`sh -c "deny.py"`) or an absolute
 * path. Stdin gets the JSON payload, stdout is parsed for the decision.
 *
 * Failure modes — all collapse to a deny with a descriptive reason so the
 * loop never proceeds on ambiguous hook output:
 *   - hook exits non-zero → deny with stderr first line
 *   - hook stdout isn't valid JSON → deny with parse error
 *   - hook stdout JSON missing `decision` field → deny with shape error
 *   - hook hangs past HOOK_TIMEOUT_MS → kill, deny with "hook timeout"
 *
 * Returns the elapsed ms separately so the caller can attribute hook latency
 * to its own bucket in stats (vs. confusing it for tool latency).
 */
export async function runPreToolHook(
  hookCmd: string,
  input: PreToolHookInput,
): Promise<{ decision: PreToolHookDecision; elapsedMs: number }> {
  const started = Date.now();
  const payload = JSON.stringify(input);

  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", hookCmd], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, HOOK_TIMEOUT_MS);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        decision: { decision: "deny", reason: `hook spawn failed: ${err.message}` },
        elapsedMs: Date.now() - started,
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - started;

      if (timedOut) {
        resolve({ decision: { decision: "deny", reason: "hook timeout" }, elapsedMs });
        return;
      }

      if (code !== 0) {
        const firstLine = stderr.split("\n")[0]?.trim() ?? "";
        const reason = firstLine || `hook exited ${code}`;
        resolve({ decision: { decision: "deny", reason }, elapsedMs });
        return;
      }

      // Empty stdout = implicit allow (lets users write `exit 0` to allow,
      // anything else to deny — common shell-script ergonomics).
      if (stdout.trim() === "") {
        resolve({ decision: { decision: "allow" }, elapsedMs });
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        const decision = parsed["decision"];
        if (decision === "allow") {
          resolve({ decision: { decision: "allow" }, elapsedMs });
        } else if (decision === "deny") {
          const reason = typeof parsed["reason"] === "string" ? parsed["reason"] : "denied by hook";
          resolve({ decision: { decision: "deny", reason }, elapsedMs });
        } else {
          resolve({
            decision: {
              decision: "deny",
              reason: `hook output missing or invalid 'decision' field: ${stdout.slice(0, 100)}`,
            },
            elapsedMs,
          });
        }
      } catch (err) {
        resolve({
          decision: {
            decision: "deny",
            reason: `hook stdout was not valid JSON: ${(err as Error).message}`,
          },
          elapsedMs,
        });
      }
    });

    proc.stdin.write(payload);
    proc.stdin.end();
  });
}
