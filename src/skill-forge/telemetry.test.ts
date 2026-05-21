import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listTelemetryEntries,
  readTelemetry,
  recordSkillCreation,
  recordSkillDemotion,
  recordSkillPromotion,
  recordSkillUsage,
} from "./telemetry.js";

describe("skill-forge telemetry", () => {
  let stateDir: string;
  const env = (): NodeJS.ProcessEnv => ({
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  });

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-tel-"));
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("creates a staged entry with usageCount 0", async () => {
    const now = new Date("2026-05-20T18:00:00Z");
    const entry = await recordSkillCreation({ name: "alpha", now, env: env() });
    expect(entry).toMatchObject({
      name: "alpha",
      status: "staged",
      createdAt: "2026-05-20T18:00:00.000Z",
      usageCount: 0,
    });
  });

  it("recordSkillCreation is idempotent (returns existing entry)", async () => {
    await recordSkillCreation({
      name: "alpha",
      now: new Date("2026-05-20T18:00:00Z"),
      env: env(),
    });
    const second = await recordSkillCreation({
      name: "alpha",
      now: new Date("2030-01-01T00:00:00Z"),
      env: env(),
    });
    expect(second.createdAt).toBe("2026-05-20T18:00:00.000Z");
  });

  it("promotion sets status=promoted and stamps promotedAt", async () => {
    await recordSkillCreation({
      name: "beta",
      now: new Date("2026-05-20T18:00:00Z"),
      env: env(),
    });
    const promoted = await recordSkillPromotion({
      name: "beta",
      now: new Date("2026-05-20T19:00:00Z"),
      env: env(),
    });
    expect(promoted).toMatchObject({
      status: "promoted",
      promotedAt: "2026-05-20T19:00:00.000Z",
    });
  });

  it("usage increments counter and updates lastUsedAt", async () => {
    await recordSkillUsage({
      name: "gamma",
      now: new Date("2026-05-20T18:00:00Z"),
      env: env(),
    });
    const second = await recordSkillUsage({
      name: "gamma",
      now: new Date("2026-05-20T20:00:00Z"),
      env: env(),
    });
    expect(second.usageCount).toBe(2);
    expect(second.lastUsedAt).toBe("2026-05-20T20:00:00.000Z");
  });

  it("demotion sets status=retired with reason", async () => {
    await recordSkillPromotion({
      name: "delta",
      now: new Date("2026-05-20T18:00:00Z"),
      env: env(),
    });
    const retired = await recordSkillDemotion({
      name: "delta",
      reason: "unused for 31 days",
      now: new Date("2026-06-20T18:00:00Z"),
      env: env(),
    });
    expect(retired).toMatchObject({
      status: "retired",
      retiredReason: "unused for 31 days",
    });
  });

  it("listTelemetryEntries returns all entries", async () => {
    await recordSkillCreation({ name: "a", env: env() });
    await recordSkillCreation({ name: "b", env: env() });
    const entries = await listTelemetryEntries(env());
    expect(entries.map((e) => e.name).toSorted()).toEqual(["a", "b"]);
  });

  it("readTelemetry returns null for unknown skill", async () => {
    expect(await readTelemetry({ name: "missing", env: env() })).toBeNull();
  });
});
