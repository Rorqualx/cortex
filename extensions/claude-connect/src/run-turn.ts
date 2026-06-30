// Spawns the Claude Code CLI for one turn and projects its stream-json (NDJSON)
// output into typed events. No Agent SDK: this drives the supported `claude -p
// --output-format stream-json` interface directly. The line parser is kept pure
// and exported so it can be unit-tested against captured CLI output.
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

export type ClaudeTurnEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "result"; text: string; isError: boolean; sessionId?: string };

export type RunClaudeTurnParams = {
  binary: string;
  args: string[];
  cwd: string;
  prompt: string;
  /** Kill the turn if the CLI emits nothing for this long. 0 disables. */
  idleTimeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: ClaudeTurnEvent) => void;
};

export type ClaudeTurnResult = {
  sessionId?: string;
  finalText: string;
  isError: boolean;
};

type StreamBlock = { type?: string; text?: unknown; name?: unknown };

/** Parses one NDJSON stream-json line into zero or more typed turn events. */
export function parseClaudeStreamLine(line: string): ClaudeTurnEvent[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;

  if (type === "system" && obj.subtype === "init" && typeof obj.session_id === "string") {
    return [{ kind: "session", sessionId: obj.session_id }];
  }

  if (type === "assistant") {
    const message = obj.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message.content as StreamBlock[]) : [];
    const events: ClaudeTurnEvent[] = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        events.push({ kind: "assistant", text: block.text });
      } else if (block?.type === "tool_use" && typeof block.name === "string") {
        events.push({ kind: "tool", name: block.name });
      }
    }
    return events;
  }

  if (type === "result") {
    const text = typeof obj.result === "string" ? obj.result : "";
    // `subtype: "success"` is the only non-error terminal state; everything else
    // (error_max_turns, error_during_execution, …) is a failed turn.
    const isError =
      obj.is_error === true || (typeof obj.subtype === "string" && obj.subtype !== "success");
    const sessionId = typeof obj.session_id === "string" ? obj.session_id : undefined;
    return [{ kind: "result", text, isError, ...(sessionId ? { sessionId } : {}) }];
  }

  return [];
}

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // best-effort
  }
  // Escalate if the process ignores SIGTERM; unref so the timer never holds the event loop.
  setTimeout(() => {
    if (child.exitCode === null && !child.signalCode) {
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
    }
  }, 2000).unref();
}

function toSpawnError(err: unknown, binary: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return new Error(
      `claude-connect: Claude Code CLI not found (tried "${binary}"). Install with ` +
        `\`npm i -g @anthropic-ai/claude-code\`, or set ` +
        `plugins.entries.claude-connect.config.binaryPath.`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Runs one delegated turn end-to-end, streaming events and resolving on the terminal `result`. */
export async function runClaudeTurn(params: RunClaudeTurnParams): Promise<ClaudeTurnResult> {
  if (params.signal?.aborted) {
    throw new Error("claude-connect: turn aborted before start");
  }

  return await new Promise<ClaudeTurnResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(params.binary, params.args, {
        cwd: params.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(toSpawnError(err, params.binary));
      return;
    }

    let settled = false;
    let terminal = false;
    let sessionId: string | undefined;
    let resultText: string | undefined;
    let isError = false;
    const assistantChunks: string[] = [];
    let stderr = "";

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const bumpIdle = () => {
      clearIdle();
      if (params.idleTimeoutMs > 0) {
        idleTimer = setTimeout(
          () => fail(new Error(`claude-connect: turn idle for ${params.idleTimeoutMs}ms`)),
          params.idleTimeoutMs,
        );
        idleTimer.unref();
      }
    };

    const cleanup = () => {
      clearIdle();
      params.signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({
        ...(sessionId ? { sessionId } : {}),
        finalText: resultText ?? assistantChunks.join("\n\n").trim(),
        isError,
      });
    };
    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      killChild(child);
      reject(err);
    };
    const onAbort = () => fail(new Error("claude-connect: turn aborted"));
    params.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => fail(toSpawnError(err, params.binary)));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) {
        stderr = stderr.slice(-8192);
      }
    });

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (!terminal) {
          bumpIdle();
        }
        for (const event of parseClaudeStreamLine(line)) {
          if (event.kind === "session") {
            sessionId = event.sessionId;
          } else if (event.kind === "assistant") {
            assistantChunks.push(event.text);
          } else if (event.kind === "result") {
            resultText = event.text;
            isError = event.isError;
            sessionId ??= event.sessionId;
            // The terminal turn event carries the full answer. Stop the idle
            // watchdog and resolve now so a slow process exit cannot reject a
            // turn we have already completed.
            terminal = true;
            clearIdle();
          }
          params.onEvent?.(event);
        }
        if (terminal) {
          finish();
          killChild(child);
        }
      });
    }

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      if (resultText !== undefined) {
        finish();
        return;
      }
      // No terminal `result` arrived. If the CLI still streamed assistant text,
      // return it but reflect a non-zero/killed exit as an error so a crashed
      // turn is never reported as a clean success.
      if (assistantChunks.length > 0) {
        isError = code !== 0 || signal !== null;
        finish();
        return;
      }
      fail(
        new Error(
          `claude-connect: claude exited (code=${code ?? "null"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        ),
      );
    });

    // The CLI may close stdin (e.g. exit early on an auth/spawn failure) before
    // we finish writing; without this listener the EPIPE would surface as an
    // unhandled stream error and crash the host process.
    child.stdin?.on("error", () => {});
    bumpIdle();
    child.stdin?.write(params.prompt);
    child.stdin?.end();
  });
}
