export const FORGE_SCHEMA = "openclaw-skill-forge" as const;
export const FORGE_SCHEMA_VERSION = 1 as const;

export type CaptureTrigger =
  | "manual"
  | "session-end"
  | "subagent-end"
  | "explicit-instruction"
  | "steering-preempt";

export type SkillForgeCaptureManifest = {
  forgeSchema: typeof FORGE_SCHEMA;
  forgeSchemaVersion: typeof FORGE_SCHEMA_VERSION;
  capturedAt: string;
  trigger: CaptureTrigger;
  traceId: string;
  sessionId: string;
  sessionKey?: string;
  eventCount: number;
  runtimeEventCount: number;
  transcriptEventCount: number;
  supplementalFiles: string[];
};

export type CaptureOk = {
  status: "captured";
  outputDir: string;
  manifest: SkillForgeCaptureManifest;
};

export type CaptureSkipped = {
  status: "skipped";
  reason: string;
  error?: unknown;
};

export type CaptureResult = CaptureOk | CaptureSkipped;

/**
 * Lifecycle of a promoted skill (2026-10-13, Finding 6 — pre-retire fitness
 * gate). Promoted skills land as "trial" and become auto-invokable only at
 * "active"; "stable" marks long-run fitness; "retired" mirrors demotion.
 * Absent markers backfill to "active" so pre-existing promoted skills keep
 * firing.
 */
export type SkillLifecycle = "trial" | "active" | "stable" | "retired";
