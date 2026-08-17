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
  recordSkillUsageOutcome,
  USAGE_LOG_MAX_RECORDS,
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

  it("usage snapshots pool size per invocation (precision-vs-pool-size curve)", async () => {
    await recordSkillCreation({ name: "pool-a", env: env() });
    await recordSkillCreation({ name: "pool-b", env: env() });
    const used = await recordSkillUsage({ name: "pool-a", env: env() });
    expect(used.usageLog).toEqual([{ at: used.lastUsedAt, poolSize: 2 }]);
    expect(used.lastPoolSize).toBe(2);
  });

  it("usage honors an explicit poolSize override and caps the usage log", async () => {
    const used = await recordSkillUsage({ name: "cap", poolSize: 5, env: env() });
    for (let i = 0; i < USAGE_LOG_MAX_RECORDS + 3; i += 1) {
      await recordSkillUsage({
        name: "cap",
        now: new Date(Date.parse("2026-05-20T18:00:00Z") + i * 1000),
        poolSize: 5,
        env: env(),
      });
    }
    const entry = await readTelemetry({ name: "cap", env: env() });
    expect(entry?.usageLog?.length).toBe(USAGE_LOG_MAX_RECORDS);
    expect(entry?.usageLog?.[0].at).not.toBe(used.lastUsedAt);
  });

  it("recordSkillUsageOutcome stamps the pending record post-run, decoupled fields", async () => {
    await recordSkillUsage({ name: "outcome", poolSize: 3, env: env() });
    const stamped = await recordSkillUsageOutcome({
      name: "outcome",
      taskSucceeded: true,
      env: env(),
    });
    expect(stamped?.usageLog?.[0]).toEqual({
      at: stamped?.lastUsedAt,
      poolSize: 3,
      taskSucceeded: true,
    });
    expect(stamped?.lastTaskSucceeded).toBe(true);
    expect(stamped?.lastInvocationOutcome).toBeUndefined();
    // taskSucceeded and invocationOutcome stay decoupled: a later judge stamp
    // lands on the SAME record (already has taskSucceeded but no outcome).
    const judged = await recordSkillUsageOutcome({
      name: "outcome",
      invocationOutcome: "correct",
      env: env(),
    });
    expect(judged?.usageLog?.[0].invocationOutcome).toBe("correct");
    expect(judged?.usageLog?.[0].taskSucceeded).toBe(true);
    expect(judged?.lastInvocationOutcome).toBe("correct");
  });

  it("recordSkillUsageOutcome drains pending records newest-first, then null", async () => {
    await recordSkillUsage({ name: "multi", poolSize: 1, env: env() });
    await recordSkillUsage({ name: "multi", poolSize: 1, env: env() });
    const stamped = await recordSkillUsageOutcome({
      name: "multi",
      taskSucceeded: false,
      env: env(),
    });
    const log = stamped?.usageLog ?? [];
    expect(log[0].taskSucceeded).toBeUndefined();
    expect(log[1].taskSucceeded).toBe(false);
    expect(stamped?.lastTaskSucceeded).toBe(false);
    // Second outcome drains the remaining pending record…
    const second = await recordSkillUsageOutcome({
      name: "multi",
      taskSucceeded: true,
      env: env(),
    });
    expect(second?.usageLog?.[0].taskSucceeded).toBe(true);
    // …and with nothing pending a third call is a no-op null — never invents one.
    expect(
      await recordSkillUsageOutcome({ name: "multi", taskSucceeded: true, env: env() }),
    ).toBeNull();
  });

  it("recordSkillUsageOutcome returns null for unknown skill or empty log", async () => {
    expect(
      await recordSkillUsageOutcome({ name: "ghost", taskSucceeded: true, env: env() }),
    ).toBeNull();
    await recordSkillCreation({ name: "no-log", env: env() });
    expect(
      await recordSkillUsageOutcome({ name: "no-log", taskSucceeded: true, env: env() }),
    ).toBeNull();
  });
});
