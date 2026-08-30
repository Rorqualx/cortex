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
