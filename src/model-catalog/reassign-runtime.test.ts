// Covers listAliasServedVersions: alias pins cross-referenced with recorded
// silent-upgrade links (the dated checkpoint sub-version surface for doctor).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { upsertProbedServedModels } from "./discovered-store.js";
import { listAliasServedVersions } from "./reassign-runtime.js";

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

describe("listAliasServedVersions", () => {
  it("maps alias pins onto recorded silent-upgrade sub-versions", async () => {
    await stubStateDir("alias-served-");
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
      1_756_600_000_000,
    );
    const cfg = {
      agents: { defaults: { models: { "deepseek/deepseek-v4-pro": { alias: "Fast" } } } },
    } as unknown as OpenClawConfig;
    expect(listAliasServedVersions(cfg)).toEqual([
      {
        alias: "Fast",
        provider: "deepseek",
        pinnedModelId: "deepseek-v4-pro",
        servedModelId: "DeepSeek-V4-Pro-0813",
        lastSeenMs: 1_756_600_000_000,
      },
    ]);
  });

  it("returns empty when no upgrade links are recorded", async () => {
    await stubStateDir("alias-saved-empty-");
    const cfg = {
      agents: { defaults: { models: { "deepseek/deepseek-v4-pro": { alias: "Fast" } } } },
    } as unknown as OpenClawConfig;
    expect(listAliasServedVersions(cfg)).toEqual([]);
  });

  it("ignores alias pins with no matching upgrade link", async () => {
    await stubStateDir("alias-saved-nomatch-");
    const { db } = openOpenClawStateDatabase();
    upsertProbedServedModels(
      db,
      "zai",
      [{ modelId: "glm-5.2", raw: { id: "glm-5.2", via: "probe", upgradedFrom: ["glm-5.1"] } }],
      1000,
    );
    const cfg = {
      agents: { defaults: { models: { "deepseek/deepseek-v4-pro": { alias: "Fast" } } } },
    } as unknown as OpenClawConfig;
    expect(listAliasServedVersions(cfg)).toEqual([]);
  });
});
