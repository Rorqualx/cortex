// Covers the gateway model-catalog refresh cadence resolver + start/stop lifecycle.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveModelCatalogRefreshIntervalMs,
  startGatewayModelCatalogRefresh,
} from "./model-catalog-refresh.js";

function cfg(refreshIntervalHours?: number): OpenClawConfig {
  return {
    models: refreshIntervalHours === undefined ? {} : { refreshIntervalHours },
  } as OpenClawConfig;
}

const getLog = () => ({ info: () => {}, warn: () => {}, error: () => {} });

describe("resolveModelCatalogRefreshIntervalMs", () => {
  it("defaults to 24h when unset", () => {
    expect(resolveModelCatalogRefreshIntervalMs(cfg())).toBe(24 * 3600_000);
  });

  it("uses the configured hours", () => {
    expect(resolveModelCatalogRefreshIntervalMs(cfg(6))).toBe(6 * 3600_000);
  });

  it("returns null (disabled) for 0 or negative", () => {
    expect(resolveModelCatalogRefreshIntervalMs(cfg(0))).toBeNull();
    expect(resolveModelCatalogRefreshIntervalMs(cfg(-1))).toBeNull();
  });
});

describe("startGatewayModelCatalogRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a no-op stop when disabled and schedules nothing", () => {
    const stop = startGatewayModelCatalogRefresh({ config: cfg(0), getLog });
    expect(vi.getTimerCount()).toBe(0);
    expect(() => stop()).not.toThrow();
  });

  it("schedules a deferred timer (no immediate run) and clears it on stop", () => {
    const stop = startGatewayModelCatalogRefresh({ config: cfg(24), getLog });
    // First pass is deferred by one interval, not run at boot.
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
