import type { ActivityEvent } from "../../packages/gateway-protocol/src/index.js";
// Projects the in-memory agent event bus into the persistent, cross-agent
// activity feed. Taps `onAgentEvent`, curates a bounded subset of streams
// (tool/item/approval/patch/plan/lifecycle/usage/thinking), writes them to the
// shared-state activity_events store, and broadcasts `activity.event` to
// subscribed Control UI connections.
//
// Design notes:
// - The `tool` stream is universal (embedded runner); the `item` stream is
//   codex/ACP only. A single run uses one runtime, so consuming both never
//   double-counts a step.
// - `usage`/`thinking` are high-frequency. We accumulate them per run in memory
//   and flush once onto the run-header row at lifecycle end rather than writing
//   per delta.
// - Run-context can be cleared before terminal events arrive, so agentId falls
//   back to parsing the session key.
import type { AgentEventPayload } from "../infra/agent-events.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { recordActivityEvent, type StoredActivityEvent } from "../state/activity-events-store.js";

const PREVIEW_LIMIT = 2_000;
const TITLE_LIMIT = 140;
const THINKING_LIMIT = 4_000;
const RUN_ACCUM_TTL_MS = 30 * 60 * 1000;
const RUN_ACCUM_MAX = 500;

type RunAccumulator = {
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: string;
  startedAt?: number;
  stepStartTs: Map<string, number>;
  touchedAt: number;
};

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Authorization|Cookie|Set-Cookie)\s*:\s*[^\n\r]+/gi, "$1: [redacted]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]"],
  [
    /\b(api[_-]?key|token|secret|password|passwd|authorization)\b(\s*[:=]\s*)["']?[^"',\s}]+/gi,
    "$1$2[redacted]",
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted private key]",
  ],
];

function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tokenCount(value: unknown): number {
  const n = num(value);
  return n !== undefined && n >= 0 ? n : 0;
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, limit), truncated: true };
}

function baseName(filePath: string): string {
  const cleaned = filePath.split(/[\\/]/).filter(Boolean);
  return cleaned.at(-1) ?? filePath;
}

function previewOf(value: unknown): { preview?: string; truncated: boolean } {
  if (value === null || value === undefined) {
    return { truncated: false };
  }
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    const record = rec(value);
    const direct = str(record?.text);
    if (direct) {
      text = direct;
    } else {
      try {
        text = JSON.stringify(value, null, 2);
      } catch {
        text = "[unserializable]";
      }
    }
  }
  const { text: clipped, truncated } = truncate(redactSecrets(text), PREVIEW_LIMIT);
  return { preview: clipped, truncated };
}

/** Maps a stored row to the protocol shape served by activity.list. */
export function toProtocolActivityEvent(row: StoredActivityEvent): ActivityEvent {
  const detail = rec(row.detail);
  const metrics = rec(row.metrics);
  return {
    eventId: row.eventId,
    ts: row.ts,
    ...(row.agentId ? { agentId: row.agentId } : {}),
    ...(row.sessionKey ? { sessionKey: row.sessionKey } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.groupKey ? { groupKey: row.groupKey } : {}),
    kind: row.kind,
    status: row.status,
    title: row.title,
    ...(detail ? { detail: detail as ActivityEvent["detail"] } : {}),
    ...(metrics ? { metrics: metrics as ActivityEvent["metrics"] } : {}),
  };
}

type ActivityRecorderDeps = {
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  getSubscriberConnIds: () => ReadonlySet<string>;
};

export function startGatewayActivityRecorder(deps: ActivityRecorderDeps): {
  activityRecorderUnsub: () => void;
} {
  const runs = new Map<string, RunAccumulator>();

  const accumFor = (runId: string): RunAccumulator => {
    let accum = runs.get(runId);
    if (!accum) {
      accum = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: "",
        stepStartTs: new Map(),
        touchedAt: Date.now(),
      };
      runs.set(runId, accum);
    }
    accum.touchedAt = Date.now();
    // Bound the map: drop the oldest run accumulators if a flood never ends.
    if (runs.size > RUN_ACCUM_MAX) {
      const cutoff = Date.now() - RUN_ACCUM_TTL_MS;
      for (const [id, value] of runs) {
        if (value.touchedAt < cutoff) {
          runs.delete(id);
        }
      }
    }
    return accum;
  };

  const persistAndBroadcast = (record: Parameters<typeof recordActivityEvent>[0]): void => {
    try {
      recordActivityEvent(record);
    } catch {
      // Activity is observability; never let a store error disrupt the run.
      return;
    }
    const connIds = deps.getSubscriberConnIds();
    if (connIds.size === 0) {
      return;
    }
    const stored: StoredActivityEvent = {
      eventId: record.eventId,
      ts: record.ts,
      agentId: record.agentId ?? null,
      sessionKey: record.sessionKey ?? null,
      runId: record.runId ?? null,
      groupKey: record.groupKey ?? null,
      kind: record.kind,
      status: record.status,
      title: record.title,
      detail: record.detail ?? null,
      metrics: record.metrics ?? null,
    };
    deps.broadcastToConnIds("activity.event", toProtocolActivityEvent(stored), connIds, {
      dropIfSlow: true,
    });
  };

  const handle = (evt: AgentEventPayload): void => {
    const data = evt.data ?? {};
    const runId = evt.runId;
    const sessionKey = str(evt.sessionKey) ?? null;
    const agentId =
      normalizeAgentId(str(evt.agentId) ?? parseAgentSessionKey(sessionKey ?? "")?.agentId) || null;
    const ts = num(evt.ts) ?? Date.now();
    const base = { runId, sessionKey, agentId, groupKey: runId, ts };

    // Opportunistically capture the active model from any event that carries it.
    const model =
      str(data.model) ?? str(data.modelRef) ?? str(data.activeModel) ?? str(data.selectedModel);
    if (model) {
      accumFor(runId).model = model;
    }

    switch (evt.stream) {
      case "usage": {
        const accum = accumFor(runId);
        accum.input += tokenCount(data.input);
        accum.output += tokenCount(data.output);
        accum.cacheRead += tokenCount(data.cacheRead);
        accum.cacheWrite += tokenCount(data.cacheWrite);
        return;
      }
      case "thinking": {
        const text = str(data.text) ?? str(data.summary) ?? str(data.delta);
        if (text) {
          const accum = accumFor(runId);
          accum.thinking = `${accum.thinking}${text}`.slice(-THINKING_LIMIT);
        }
        return;
      }
      case "tool": {
        recordToolStep(data, base, accumFor(runId), persistAndBroadcast);
        return;
      }
      case "item": {
        recordItemStep(data, base, persistAndBroadcast);
        return;
      }
      case "approval": {
        recordApprovalStep(data, base, persistAndBroadcast);
        return;
      }
      case "patch": {
        recordPatchStep(data, base, persistAndBroadcast);
        return;
      }
      case "plan": {
        const title = str(data.title);
        if (title) {
          persistAndBroadcast({
            ...base,
            eventId: `${runId}:plan`,
            kind: "plan",
            status: "info",
            title: truncate(title, TITLE_LIMIT).text,
          });
        }
        return;
      }
      case "lifecycle": {
        recordLifecycle(data, base, runs, persistAndBroadcast);
        return;
      }
      default:
        break;
    }
  };

  const activityRecorderUnsub = onAgentEvent(handle);
  return { activityRecorderUnsub };
}

function toolStatus(data: Record<string, unknown>): "running" | "ok" | "error" {
  if (str(data.phase) !== "result") {
    return "running";
  }
  if (data.isError === true || data.is_error === true) {
    return "error";
  }
  const result = rec(data.result);
  if (result?.isError === true || result?.is_error === true) {
    return "error";
  }
  const status = str(data.status) ?? str(result?.status);
  if (status && /error|fail/i.test(status)) {
    return "error";
  }
  const exitCode = num(result?.exitCode ?? data.exitCode);
  if (exitCode !== undefined && exitCode !== 0) {
    return "error";
  }
  return "ok";
}

function toolTitle(name: string, args: unknown): { title: string; summary?: string } {
  const record = rec(args);
  const command = str(record?.command) ?? str(record?.cmd) ?? str(record?.script);
  if (command) {
    return {
      title: truncate(`${name}: ${command.split("\n")[0]}`, TITLE_LIMIT).text,
      summary: command,
    };
  }
  const file =
    str(record?.file_path) ??
    str(record?.path) ??
    str(record?.filePath) ??
    str(record?.file) ??
    str(record?.notebook_path);
  if (file) {
    return { title: `${name} ${baseName(file)}`, summary: file };
  }
  const needle =
    str(record?.pattern) ?? str(record?.query) ?? str(record?.url) ?? str(record?.prompt);
  if (needle) {
    return { title: truncate(`${name} ${needle}`, TITLE_LIMIT).text, summary: needle };
  }
  return { title: name };
}

function recordToolStep(
  data: Record<string, unknown>,
  base: {
    runId: string;
    sessionKey: string | null;
    agentId: string | null;
    groupKey: string;
    ts: number;
  },
  accum: RunAccumulator,
  emit: (record: Parameters<typeof recordActivityEvent>[0]) => void,
): void {
  const toolCallId = str(data.toolCallId);
  if (!toolCallId) {
    return;
  }
  const phase = str(data.phase);
  if (phase === "update") {
    return;
  }
  const name = str(data.name) ?? "tool";
  const eventId = `${base.runId}:tool:${toolCallId}`;
  if (phase === "start") {
    accum.stepStartTs.set(eventId, base.ts);
  }
  const status = toolStatus(data);
  const { title, summary } = toolTitle(name, data.args);
  const outputValue = phase === "result" ? data.result : undefined;
  const { preview, truncated } = previewOf(outputValue);
  const startedAt = accum.stepStartTs.get(eventId);
  const durationMs = phase === "result" && startedAt ? Math.max(0, base.ts - startedAt) : undefined;
  if (phase === "result") {
    accum.stepStartTs.delete(eventId);
  }
  const detail = {
    ...(summary ? { summary } : {}),
    ...(preview ? { preview } : {}),
    ...(truncated ? { truncated } : {}),
  };
  emit({
    ...base,
    eventId,
    kind: "tool",
    status,
    title,
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
    ...(durationMs !== undefined ? { metrics: { durationMs } } : {}),
  });
}

function itemStatus(value: string | undefined): "running" | "ok" | "error" | "blocked" {
  switch (value) {
    case "completed":
      return "ok";
    case "failed":
      return "error";
    case "blocked":
      return "blocked";
    default:
      return "running";
  }
}

function recordItemStep(
  data: Record<string, unknown>,
  base: {
    runId: string;
    sessionKey: string | null;
    agentId: string | null;
    groupKey: string;
    ts: number;
  },
  emit: (record: Parameters<typeof recordActivityEvent>[0]) => void,
): void {
  const itemId = str(data.itemId);
  if (!itemId) {
    return;
  }
  if (str(data.phase) === "update") {
    return;
  }
  const kind = str(data.kind) ?? "tool";
  const title = str(data.title) ?? kind;
  const eventId = `${base.runId}:item:${itemId}`;
  const startedAt = num(data.startedAt);
  const endedAt = num(data.endedAt);
  const durationMs =
    startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : undefined;
  const summary = str(data.summary);
  const meta = str(data.meta);
  const error = str(data.error);
  const detail = {
    ...(summary ? { summary } : {}),
    ...(meta ? { meta } : {}),
    ...(error ? { error } : {}),
  };
  emit({
    ...base,
    eventId,
    kind,
    status: itemStatus(str(data.status)),
    title: truncate(title, TITLE_LIMIT).text,
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
    ...(durationMs !== undefined ? { metrics: { durationMs } } : {}),
  });
}

function approvalStatus(value: string | undefined): "ok" | "error" | "blocked" {
  switch (value) {
    case "approved":
      return "ok";
    case "denied":
    case "failed":
      return "error";
    default:
      return "blocked";
  }
}

function recordApprovalStep(
  data: Record<string, unknown>,
  base: {
    runId: string;
    sessionKey: string | null;
    agentId: string | null;
    groupKey: string;
    ts: number;
  },
  emit: (record: Parameters<typeof recordActivityEvent>[0]) => void,
): void {
  const approvalId = str(data.approvalId) ?? str(data.itemId) ?? str(data.toolCallId);
  if (!approvalId) {
    return;
  }
  const title = str(data.title) ?? "Approval";
  const summary = str(data.command) ?? str(data.host) ?? str(data.reason) ?? str(data.message);
  emit({
    ...base,
    eventId: `${base.runId}:approval:${approvalId}`,
    kind: "approval",
    status: approvalStatus(str(data.status)),
    title: truncate(title, TITLE_LIMIT).text,
    detail: {
      approvalId,
      ...(summary ? { summary } : {}),
    },
  });
}

function recordPatchStep(
  data: Record<string, unknown>,
  base: {
    runId: string;
    sessionKey: string | null;
    agentId: string | null;
    groupKey: string;
    ts: number;
  },
  emit: (record: Parameters<typeof recordActivityEvent>[0]) => void,
): void {
  const itemId = str(data.itemId) ?? str(data.toolCallId);
  if (!itemId) {
    return;
  }
  const title = str(data.title) ?? "Applied patch";
  const summary = str(data.summary);
  const files = [
    ...(Array.isArray(data.added) ? (data.added as unknown[]).map((f) => `+ ${String(f)}`) : []),
    ...(Array.isArray(data.modified)
      ? (data.modified as unknown[]).map((f) => `~ ${String(f)}`)
      : []),
    ...(Array.isArray(data.deleted)
      ? (data.deleted as unknown[]).map((f) => `- ${String(f)}`)
      : []),
  ];
  const preview =
    files.length > 0 ? truncate(redactSecrets(files.join("\n")), PREVIEW_LIMIT).text : undefined;
  emit({
    ...base,
    eventId: `${base.runId}:patch:${itemId}`,
    kind: "patch",
    status: "ok",
    title: truncate(title, TITLE_LIMIT).text,
    detail: {
      ...(summary ? { summary } : {}),
      ...(preview ? { preview } : {}),
    },
  });
}

function recordLifecycle(
  data: Record<string, unknown>,
  base: {
    runId: string;
    sessionKey: string | null;
    agentId: string | null;
    groupKey: string;
    ts: number;
  },
  runs: Map<string, RunAccumulator>,
  emit: (record: Parameters<typeof recordActivityEvent>[0]) => void,
): void {
  const phase = str(data.phase);
  if (phase !== "start" && phase !== "end" && phase !== "error") {
    return;
  }
  const accum = runs.get(base.runId);
  if (phase === "start") {
    const startedAt = num(data.startedAt) ?? base.ts;
    const created = accum ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: "",
      stepStartTs: new Map<string, number>(),
      touchedAt: base.ts,
    };
    created.startedAt = startedAt;
    runs.set(base.runId, created);
    emit({
      ...base,
      eventId: `${base.runId}:run`,
      kind: "lifecycle",
      status: "running",
      title: "Run started",
      ...(created.model ? { detail: { model: created.model } } : {}),
    });
    return;
  }

  const endedAt = num(data.endedAt) ?? base.ts;
  const durationMs = accum?.startedAt ? Math.max(0, endedAt - accum.startedAt) : undefined;
  const metrics = {
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(accum && accum.input > 0 ? { inputTokens: accum.input } : {}),
    ...(accum && accum.output > 0 ? { outputTokens: accum.output } : {}),
    ...(accum && accum.cacheRead > 0 ? { cacheReadTokens: accum.cacheRead } : {}),
    ...(accum && accum.cacheWrite > 0 ? { cacheWriteTokens: accum.cacheWrite } : {}),
  };
  const error = str(data.error);
  emit({
    ...base,
    eventId: `${base.runId}:run`,
    kind: "lifecycle",
    status: phase === "error" ? "error" : "ok",
    title: phase === "error" ? "Run failed" : "Run finished",
    detail: {
      ...(accum?.model ? { model: accum.model } : {}),
      ...(error ? { error } : {}),
    },
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
  });

  // Flush an accumulated thinking trace as its own row, then release the run.
  if (accum?.thinking.trim()) {
    const { text, truncated } = truncate(accum.thinking.trim(), PREVIEW_LIMIT);
    emit({
      ...base,
      eventId: `${base.runId}:thinking`,
      kind: "thinking",
      status: "info",
      title: "Thinking",
      detail: { preview: text, ...(truncated ? { truncated } : {}) },
    });
  }
  runs.delete(base.runId);
}
