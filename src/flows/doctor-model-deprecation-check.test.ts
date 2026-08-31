// Covers the doctor model-deprecation check's silent checkpoint sub-version
// surface: detect names the dated served id per alias pin; repair without
// actions stays skipped when nothing can be probed (no usable endpoints).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { upsertProbedServedModels } from "../model-catalog/discovered-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { MODEL_DEPRECATION_HEALTH_CHECK } from "./doctor-model-deprecation-check.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  await tempDirs.cleanup();
});

async function stubStateDir(prefix: string): Promise<string> {
  const dir = await tempDirs.make(prefix);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  return dir;
}

const CFG_WITH_ALIAS = {
  agents: { defaults: { models: { "deepseek/deepseek-v4-pro": { alias: "Fast" } } } },
} as unknown as OpenClawConfig;

describe("MODEL_DEPRECATION_HEALTH_CHECK silent sub-version surface", () => {
  it("detect names the served checkpoint sub-version for an upgraded alias pin", async () => {
    await stubStateDir("doctor-subversion-");
    const { db } = openOpenClawStateDatabase();
    upsertProbedServedModels(
      db,
      "deepseek",
      [
        {
          modelId: "DeepSeek-V4-Pro-0813",
          raw: { id: "DeepSeek-V4-Pro-0813", via: "probe", upgradedFrom: ["deepseek-v4-pro"] },
        },
      ],
      Date.UTC(2026, 7, 30), // 2026-08-30
    );

    const findings = await MODEL_DEPRECATION_HEALTH_CHECK.detect({
      mode: "check",
      runtime: { platform: "darwin" } as never,
      cfg: CFG_WITH_ALIAS,
      env: process.env,
    });

    const subVersion = findings.find((f) => f.message.includes("checkpoint sub-version"));
    expect(subVersion).toBeDefined();
    expect(subVersion?.severity).toBe("info");
    expect(subVersion?.message).toContain('Alias "Fast" pins deepseek-v4-pro');
    expect(subVersion?.message).toContain("confirmed 2026-08-30");
  });

  it("detect emits no sub-version findings when no links are recorded", async () => {
    await stubStateDir("doctor-subversion-none-");
    const findings = await MODEL_DEPRECATION_HEALTH_CHECK.detect({
      mode: "check",
      runtime: { platform: "darwin" } as never,
      cfg: {} as OpenClawConfig,
      env: process.env,
    });
    expect(findings.filter((f) => f.message.includes("checkpoint sub-version"))).toEqual([]);
  });

  it("repair stays skipped with no actions and no probeable endpoints", async () => {
    await stubStateDir("doctor-subversion-repair-");
    // Alias pin exists, but the provider has no baseUrl/credentials, so the
    // re-probe has nothing to fire at — repair must skip cleanly.
    const result = await MODEL_DEPRECATION_HEALTH_CHECK.repair({
      mode: "fix",
      runtime: { platform: "darwin" } as never,
      cfg: CFG_WITH_ALIAS,
      env: process.env,
    });
    expect(result.status).toBe("skipped");
  });
});
