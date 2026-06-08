// Sandbox config tests cover resolved agent sandbox settings after config
// normalization and timer-safe clamping.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
// Import the new os-sandbox helpers for testing
import {
  shouldApplyOsSandbox,
  buildSeatbeltConfigWithOverrides,
} from "../../sandbox/os-sandbox.js";
import { resolveSandboxConfigForAgent } from "./config.js";

describe("sandbox config", () => {
  it("caps browser autostart timeout to a timer-safe delay", () => {
    // Browser startup timeouts flow into Node timers; huge config values must
    // not overflow or become immediate delays.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            browser: {
              autoStartTimeoutMs: Number.MAX_SAFE_INTEGER,
            },
          },
        },
      },
    };

    expect(resolveSandboxConfigForAgent(cfg, "main").browser.autoStartTimeoutMs).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });
});

describe("sandbox osSandbox config resolution", () => {
  it("defaults to disabled", () => {
    const cfg: OpenClawConfig = {};
    const resolved = resolveSandboxConfigForAgent(cfg, "main");
    expect(resolved.osSandbox.enabled).toBe(false);
  });

  it("reads global osSandbox.enabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            osSandbox: { enabled: true },
          },
        },
      },
    };
    const resolved = resolveSandboxConfigForAgent(cfg, "main");
    expect(resolved.osSandbox.enabled).toBe(true);
  });

  it("merges global + agent extraWritableRoots", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            osSandbox: {
              extraWritableRoots: ["/global/path"],
            },
          },
        },
        list: [
          {
            id: "worker",
            sandbox: {
              osSandbox: {
                extraWritableRoots: ["/agent/path"],
              },
            },
          },
        ],
      },
    };
    const resolved = resolveSandboxConfigForAgent(cfg, "worker");
    expect(resolved.osSandbox.extraWritableRoots).toEqual(["/global/path", "/agent/path"]);
  });

  it("merges global + agent extraProtectedMetadata", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            osSandbox: {
              extraProtectedMetadata: [".npmrc"],
            },
          },
        },
        list: [
          {
            id: "worker",
            sandbox: {
              osSandbox: {
                extraProtectedMetadata: [".vault-token"],
              },
            },
          },
        ],
      },
    };
    const resolved = resolveSandboxConfigForAgent(cfg, "worker");
    expect(resolved.osSandbox.extraProtectedMetadata).toEqual([".npmrc", ".vault-token"]);
  });

  it("agent network override wins over global", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            osSandbox: {
              network: "deny",
            },
          },
        },
        list: [
          {
            id: "worker",
            sandbox: {
              osSandbox: {
                network: "allow",
              },
            },
          },
        ],
      },
    };
    const resolved = resolveSandboxConfigForAgent(cfg, "worker");
    expect(resolved.osSandbox.network).toBe("allow");
  });

  it("defaults network to allow-loopback", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            osSandbox: { enabled: true },
          },
        },
      },
    };
    const resolved = resolveSandboxConfigForAgent(cfg, "main");
    expect(resolved.osSandbox.network).toBe("allow-loopback");
  });
});

describe("shouldApplyOsSandbox", () => {
  it("returns false when config is undefined", () => {
    expect(shouldApplyOsSandbox(undefined, false)).toBe(false);
  });

  it("returns false when enabled is false", () => {
    expect(
      shouldApplyOsSandbox(
        {
          enabled: false,
          extraWritableRoots: [],
          extraProtectedMetadata: [],
          network: "allow-loopback",
        },
        false,
      ),
    ).toBe(false);
  });

  it("returns false for Docker exec", () => {
    expect(
      shouldApplyOsSandbox(
        {
          enabled: true,
          extraWritableRoots: [],
          extraProtectedMetadata: [],
          network: "allow-loopback",
        },
        true,
      ),
    ).toBe(false);
  });

  it("returns true when enabled and not Docker", () => {
    // This test is platform-dependent — only passes on macOS
    if (process.platform === "darwin") {
      expect(
        shouldApplyOsSandbox(
          {
            enabled: true,
            extraWritableRoots: [],
            extraProtectedMetadata: [],
            network: "allow-loopback",
          },
          false,
        ),
      ).toBe(true);
    }
  });
});

describe("buildSeatbeltConfigWithOverrides", () => {
  it("merges extra writable roots", () => {
    const config = buildSeatbeltConfigWithOverrides("/tmp/test", {
      enabled: true,
      extraWritableRoots: ["/home/user/.cache"],
      extraProtectedMetadata: [".npmrc"],
      network: "deny",
    });
    const writablePaths = config.writableRoots.map((r) => r.path);
    expect(writablePaths).toContain("/home/user/.cache");
  });

  it("merges extra protected metadata", () => {
    const config = buildSeatbeltConfigWithOverrides("/tmp/test", {
      enabled: true,
      extraWritableRoots: [],
      extraProtectedMetadata: [".npmrc", ".vault-token"],
      network: "allow-loopback",
    });
    expect(config.protectedMetadata).toContain(".npmrc");
    expect(config.protectedMetadata).toContain(".vault-token");
    // Base defaults still present
    expect(config.protectedMetadata).toContain(".env");
    expect(config.protectedMetadata).toContain(".git");
  });

  it("overrides network policy", () => {
    const config = buildSeatbeltConfigWithOverrides("/tmp/test", {
      enabled: true,
      extraWritableRoots: [],
      extraProtectedMetadata: [],
      network: "deny",
    });
    expect(config.network).toBe("deny");
  });
});
