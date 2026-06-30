// The three claude-connect agent tools: open a Claude Code session, send a
// turn (multi-turn via `--resume`), and close it. Streamed CLI events are
// relayed to the channel as throttled tool-progress; the full answer is
// returned in the model-facing tool content.
import { randomUUID } from "node:crypto";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "../api.js";
import { assertTaskCwdAllowed, buildClaudeTurnArgs, type SessionMode } from "./claude-args.js";
import { getSessionRegistry, type SessionRecord } from "./registry.js";
import { runClaudeTurn, type ClaudeTurnEvent } from "./run-turn.js";

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const PROGRESS_ID = "claude-stream";
const PROGRESS_MAX_LEN = 280;

export type ClaudeConnectConfig = {
  defaultCwd?: string;
  binaryPath?: string;
  idleTurnTimeoutMs?: number;
};

export type ClaudeConnectFactoryContext = {
  api: OpenClawPluginApi;
  config: ClaudeConnectConfig;
  toolContext: OpenClawPluginToolContext;
};

// Progress is a public UI side-channel: keep it a short summary, never the full
// (possibly sensitive) answer, and reuse a stable id so the preview line is
// replaced rather than appended (no token-delta spam).
function emitProgress(onUpdate: AgentToolUpdateCallback | undefined, text: string): void {
  if (!onUpdate) {
    return;
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return;
  }
  const clipped =
    collapsed.length > PROGRESS_MAX_LEN
      ? `${collapsed.slice(0, PROGRESS_MAX_LEN - 1)}…`
      : collapsed;
  try {
    onUpdate({
      content: [],
      details: undefined,
      progress: { text: clipped, visibility: "channel", privacy: "public", id: PROGRESS_ID },
    });
  } catch {
    // Progress is best-effort; tool execution must not depend on subscribers.
  }
}

function relay(onUpdate: AgentToolUpdateCallback | undefined, event: ClaudeTurnEvent): void {
  if (event.kind === "assistant") {
    emitProgress(onUpdate, event.text);
  } else if (event.kind === "tool") {
    emitProgress(onUpdate, `Claude is using ${event.name}…`);
  }
}

// Serialize turns per session handle: concurrent sends would each `--resume`
// the same id, forking the conversation and racing the persisted session id.
const handleLocks = new Map<string, Promise<unknown>>();

function withHandleLock<T>(handle: string, fn: () => Promise<T>): Promise<T> {
  const prev = handleLocks.get(handle) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  handleLocks.set(
    handle,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function resolveBinary(config: ClaudeConnectConfig): string {
  return config.binaryPath?.trim() || "claude";
}

export function resolveIdleTimeout(config: ClaudeConnectConfig): number {
  const value = config.idleTurnTimeoutMs;
  // 0 explicitly disables the idle watchdog; negative/unset falls back to default.
  if (value === 0) {
    return 0;
  }
  return typeof value === "number" && value > 0 ? value : DEFAULT_IDLE_TIMEOUT_MS;
}

export function resolveCwd(
  ctx: ClaudeConnectFactoryContext,
  requested: string | undefined,
  mode: SessionMode,
): string {
  const explicit = requested?.trim() || ctx.config.defaultCwd?.trim();
  if (explicit) {
    return explicit;
  }
  // task mode runs with write/exec (acceptEdits); never silently default to the
  // gateway working directory (often the OpenClaw source repo). research mode is
  // read-only, so a workspace default is safe.
  if (mode === "task") {
    throw new Error(
      "claude-connect: task mode requires an explicit cwd (or config.defaultCwd); " +
        "refusing to default to the gateway working directory.",
    );
  }
  return ctx.toolContext.workspaceDir?.trim() || process.cwd();
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

// ---- claude_session_open -------------------------------------------------

export const openToolDefinition = {
  name: "claude_session_open",
  label: "Open Claude Code session",
  description:
    "Open an interactive Claude Code session and return a handle for follow-up turns. " +
    "mode=task lets Claude Code edit files and run commands in cwd; mode=research is read-only " +
    "(no Write/Edit/Bash). Optionally include a first prompt to run immediately.",
  parameters: Type.Object({
    mode: stringEnum(["task", "research"], {
      description: "task = write/edit/run in cwd; research = read-only investigation.",
    }),
    prompt: Type.Optional(
      Type.String({ description: "Optional first message to send right after opening." }),
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory / repo for the session. Defaults to config or workspace.",
      }),
    ),
    label: Type.Optional(Type.String({ description: "Human label for this session." })),
  }),
};

type OpenParams = { mode: SessionMode; prompt?: string; cwd?: string; label?: string };

export function createOpenTool(ctx: ClaudeConnectFactoryContext) {
  const registry = getSessionRegistry(ctx.api);
  return {
    ...openToolDefinition,
    async execute(
      _id: string,
      params: OpenParams,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) {
      const mode = params.mode;
      const cwd = resolveCwd(ctx, params.cwd, mode);
      if (mode === "task") {
        assertTaskCwdAllowed(cwd);
      }
      const handle = randomUUID();
      const record: SessionRecord = { cwd, mode, createdAt: Date.now() };
      if (params.label?.trim()) {
        record.label = params.label.trim();
      }

      if (!params.prompt?.trim()) {
        await registry.put(handle, record);
        return textResult(
          `Opened Claude Code session.\nhandle: ${handle}\nmode: ${mode}\ncwd: ${cwd}\n` +
            `Use claude_session_send with this handle to chat.`,
          { handle, mode, cwd },
        );
      }

      const turn = await runClaudeTurn({
        binary: resolveBinary(ctx.config),
        args: buildClaudeTurnArgs({ mode }),
        cwd,
        prompt: params.prompt,
        idleTimeoutMs: resolveIdleTimeout(ctx.config),
        ...(signal ? { signal } : {}),
        onEvent: (event) => relay(onUpdate, event),
      });
      if (turn.sessionId) {
        record.claudeSessionId = turn.sessionId;
      }
      await registry.put(handle, record);

      return textResult(`session handle: ${handle}\n\n${turn.finalText || "(no output)"}`, {
        handle,
        mode,
        cwd,
        sessionId: turn.sessionId,
        isError: turn.isError,
      });
    },
  };
}

// ---- claude_session_send -------------------------------------------------

export const sendToolDefinition = {
  name: "claude_session_send",
  label: "Send to Claude Code session",
  description:
    "Send a prompt to an open Claude Code session (from claude_session_open) and return its reply. " +
    "Conversation context is preserved across turns.",
  parameters: Type.Object({
    handle: Type.String({ description: "Session handle from claude_session_open." }),
    prompt: Type.String({ description: "Message or instruction for the Claude Code session." }),
  }),
};

type SendParams = { handle: string; prompt: string };

export function createSendTool(ctx: ClaudeConnectFactoryContext) {
  const registry = getSessionRegistry(ctx.api);
  return {
    ...sendToolDefinition,
    execute(
      _id: string,
      params: SendParams,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) {
      return withHandleLock(params.handle, async () => {
        const record = await registry.get(params.handle);
        if (!record) {
          throw new Error(
            `claude-connect: unknown session handle "${params.handle}". Open one first.`,
          );
        }

        const turn = await runClaudeTurn({
          binary: resolveBinary(ctx.config),
          args: buildClaudeTurnArgs({ mode: record.mode, resumeId: record.claudeSessionId }),
          cwd: record.cwd,
          prompt: params.prompt,
          idleTimeoutMs: resolveIdleTimeout(ctx.config),
          ...(signal ? { signal } : {}),
          onEvent: (event) => relay(onUpdate, event),
        });

        // Persist the (possibly new) session id so the next turn resumes correctly.
        if (turn.sessionId && turn.sessionId !== record.claudeSessionId) {
          await registry.put(params.handle, { ...record, claudeSessionId: turn.sessionId });
        }

        return textResult(turn.finalText || "(no output)", {
          handle: params.handle,
          mode: record.mode,
          sessionId: turn.sessionId ?? record.claudeSessionId,
          isError: turn.isError,
        });
      });
    },
  };
}

// ---- claude_session_close ------------------------------------------------

export const closeToolDefinition = {
  name: "claude_session_close",
  label: "Close Claude Code session",
  description: "Forget an open Claude Code session handle. Future sends to it will fail.",
  parameters: Type.Object({
    handle: Type.String({ description: "Session handle to close." }),
  }),
};

type CloseParams = { handle: string };

export function createCloseTool(ctx: ClaudeConnectFactoryContext) {
  const registry = getSessionRegistry(ctx.api);
  return {
    ...closeToolDefinition,
    async execute(_id: string, params: CloseParams) {
      const existed = await registry.delete(params.handle);
      handleLocks.delete(params.handle);
      return textResult(
        existed ? `Closed session ${params.handle}.` : `No session ${params.handle} to close.`,
        { handle: params.handle, closed: existed },
      );
    },
  };
}
