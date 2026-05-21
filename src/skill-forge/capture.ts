import fsp from "node:fs/promises";
import path from "node:path";
import { exportTrajectoryBundle } from "../trajectory/export.js";
import { resolveSkillForgeCaptureDir } from "./paths.js";
import {
  FORGE_SCHEMA,
  FORGE_SCHEMA_VERSION,
  type CaptureResult,
  type CaptureTrigger,
  type SkillForgeCaptureManifest,
} from "./types.js";

export type CaptureSessionToForgeParams = {
  sessionFile: string;
  sessionId: string;
  workspaceDir: string;
  trigger: CaptureTrigger;
  sessionKey?: string;
  runtimeFile?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
};

export async function captureSessionToForge(
  params: CaptureSessionToForgeParams,
): Promise<CaptureResult> {
  const env = params.env ?? process.env;
  const outputDir = resolveSkillForgeCaptureDir({
    sessionId: params.sessionId,
    now: params.now,
    env,
  });
  try {
    const result = await exportTrajectoryBundle({
      outputDir,
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      runtimeFile: params.runtimeFile,
    });
    const manifest: SkillForgeCaptureManifest = {
      forgeSchema: FORGE_SCHEMA,
      forgeSchemaVersion: FORGE_SCHEMA_VERSION,
      capturedAt: (params.now ?? new Date()).toISOString(),
      trigger: params.trigger,
      traceId: result.manifest.traceId,
      sessionId: result.manifest.sessionId,
      sessionKey: result.manifest.sessionKey,
      eventCount: result.manifest.eventCount,
      runtimeEventCount: result.manifest.runtimeEventCount,
      transcriptEventCount: result.manifest.transcriptEventCount,
      supplementalFiles: result.supplementalFiles,
    };
    await fsp.writeFile(
      path.join(outputDir, "forge-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    return { status: "captured", outputDir, manifest };
  } catch (error) {
    return {
      status: "skipped",
      reason: error instanceof Error ? error.message : "capture failed",
      error,
    };
  }
}
