import { describe, it, expect } from "vitest";
import type { ResolvedOsSandbox } from "./os-sandbox.js";
import {
  getOsSandboxType,
  isOsSandboxAvailable,
  buildDefaultOsSandboxConfig,
  shouldApplyOsSandbox,
} from "./os-sandbox.js";

describe("getOsSandboxType", () => {
  it("returns a valid type", () => {
    const type = getOsSandboxType();
    expect(["seatbelt", "bubblewrap", "none"]).toContain(type);
  });

  it("returns seatbelt on macOS", () => {
    if (process.platform === "darwin") {
      expect(getOsSandboxType()).toBe("seatbelt");
    }
  });
});

describe("isOsSandboxAvailable", () => {
  it("returns boolean", () => {
    expect(typeof isOsSandboxAvailable()).toBe("boolean");
  });

  it("is true on macOS", () => {
    if (process.platform === "darwin") {
      expect(isOsSandboxAvailable()).toBe(true);
    }
  });
});

describe("buildDefaultOsSandboxConfig", () => {
  it("returns available config on macOS", () => {
    if (process.platform === "darwin") {
      const config = buildDefaultOsSandboxConfig("/tmp/test");
      expect(config).not.toBeNull();
      expect(config!.available).toBe(true);
      expect(config!.type).toBe("seatbelt");
      expect(config!.seatbelt).toBeDefined();
    }
  });

  it("includes protected metadata", () => {
    if (process.platform === "darwin") {
      const config = buildDefaultOsSandboxConfig("/tmp/test");
      expect(config!.seatbelt!.protectedMetadata).toContain(".openclaw");
    }
  });
});

describe("shouldApplyOsSandbox", () => {
  it("returns false for Docker exec", () => {
    expect(shouldApplyOsSandbox(undefined, true)).toBe(false);
  });

  it("returns false when explicitly disabled", () => {
    const disabled: ResolvedOsSandbox = {
      enabled: false,
      extraWritableRoots: [],
      extraProtectedMetadata: [],
      network: "allow",
    };
    expect(shouldApplyOsSandbox(disabled, false)).toBe(false);
  });

  it("returns false by default (opt-in only)", () => {
    // Default changed to OFF — sandbox blocks build tooling when active.
    // Must be explicitly enabled via sandbox.osSandbox config.
    expect(shouldApplyOsSandbox(undefined, false)).toBe(false);
  });

  it("respects explicit enable", () => {
    if (process.platform === "darwin") {
      const enabled: ResolvedOsSandbox = {
        enabled: true,
        extraWritableRoots: [],
        extraProtectedMetadata: [],
        network: "allow",
      };
      expect(shouldApplyOsSandbox(enabled, false)).toBe(true);
    }
  });
});
