import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveSkillForgeCandidatesDir,
  resolveSkillForgeCaptureDir,
  resolveSkillForgeClustersDir,
  resolveSkillForgeRoot,
  resolveSkillForgeSessionsDir,
  resolveSkillForgeStagingDir,
  resolveSkillForgeTelemetryDir,
} from "./paths.js";

function envWithState(stateDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  };
}

describe("skill-forge paths", () => {
  const stateDir = path.resolve("/tmp/openclaw-state-test");
  const env = envWithState(stateDir);

  it("anchors all subdirectories under <stateDir>/skill-forge", () => {
    expect(resolveSkillForgeRoot(env)).toBe(path.join(stateDir, "skill-forge"));
    expect(resolveSkillForgeSessionsDir(env)).toBe(path.join(stateDir, "skill-forge", "sessions"));
    expect(resolveSkillForgeCandidatesDir(env)).toBe(
      path.join(stateDir, "skill-forge", "candidates"),
    );
    expect(resolveSkillForgeClustersDir(env)).toBe(path.join(stateDir, "skill-forge", "clusters"));
    expect(resolveSkillForgeStagingDir(env)).toBe(path.join(stateDir, "skill-forge", "_staging"));
    expect(resolveSkillForgeTelemetryDir(env)).toBe(
      path.join(stateDir, "skill-forge", "telemetry"),
    );
  });

  it("composes capture dir as <sessions>/<safe-id>-<iso-stamp>", () => {
    const now = new Date("2026-05-20T17:30:45.123Z");
    const dir = resolveSkillForgeCaptureDir({
      sessionId: "abc/123:weird",
      now,
      env,
    });
    expect(dir).toBe(
      path.join(stateDir, "skill-forge", "sessions", "abc_123_weird-2026-05-20T17-30-45"),
    );
  });

  it("falls back to 'session' when sessionId has no safe chars", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    const dir = resolveSkillForgeCaptureDir({ sessionId: "////", now, env });
    expect(dir).toBe(path.join(stateDir, "skill-forge", "sessions", "session-2026-05-20T00-00-00"));
  });
});
