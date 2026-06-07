import { describe, it, expect } from "vitest";
import {
  buildSeatbeltProfile,
  buildDefaultSeatbeltConfig,
  wrapWithSeatbelt,
  isSeatbeltAvailable,
} from "./profile-builder.js";
import type { SeatbeltConfig } from "./types.js";

describe("buildDefaultSeatbeltConfig", () => {
  it("includes workspace as writable root", () => {
    const config = buildDefaultSeatbeltConfig("/Users/joe/project");
    expect(config.writableRoots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/Users/joe/project", access: "write" }),
      ]),
    );
  });

  it("includes system dirs as readable roots", () => {
    const config = buildDefaultSeatbeltConfig("/tmp/test");
    const paths = config.readableRoots.map((r) => r.path);
    expect(paths).toContain("/usr");
    expect(paths).toContain("/System");
    expect(paths).toContain("/Library");
    expect(paths).toContain("/opt");
  });

  it("includes protected metadata names", () => {
    const config = buildDefaultSeatbeltConfig("/tmp/test");
    expect(config.protectedMetadata).toContain(".openclaw");
    expect(config.protectedMetadata).toContain(".env");
    expect(config.protectedMetadata).toContain(".git");
    expect(config.protectedMetadata).toContain("credentials");
  });

  it("defaults to allow-loopback network", () => {
    const config = buildDefaultSeatbeltConfig("/tmp/test");
    expect(config.network).toBe("allow-loopback");
  });

  it("includes TMPDIR as writable", () => {
    const config = buildDefaultSeatbeltConfig("/tmp/test");
    expect(config.writableRoots.some((r) => r.access === "write" && r.path !== "/tmp/test")).toBe(
      true,
    );
  });
});

describe("buildSeatbeltProfile", () => {
  const minimalConfig: SeatbeltConfig = {
    writableRoots: [{ path: "/tmp/workspace", access: "write" }],
    readableRoots: [
      { path: "/usr", access: "read" },
      { path: "/tmp/workspace", access: "read" },
    ],
    protectedMetadata: [".env", ".git"],
    network: "deny",
  };

  it("includes the deny-default base policy", () => {
    const { profile } = buildSeatbeltProfile(minimalConfig);
    expect(profile).toContain("(deny default)");
  });

  it("includes file-read allow rules", () => {
    const { profile } = buildSeatbeltProfile(minimalConfig);
    expect(profile).toContain("file-read*");
  });

  it("includes file-write allow rules", () => {
    const { profile } = buildSeatbeltProfile(minimalConfig);
    expect(profile).toContain("file-write*");
  });

  it("includes protected metadata deny rules for writable roots", () => {
    const { profile } = buildSeatbeltProfile(minimalConfig);
    expect(profile).toContain(".env");
    expect(profile).toContain(".git");
    // Deny rules should use regex
    expect(profile).toContain("deny file-write*");
  });

  it("resolves parameterized paths", () => {
    const { params } = buildSeatbeltProfile(minimalConfig);
    expect(params.size).toBeGreaterThan(0);
    // Should have parameter entries for roots
    expect(Array.from(params.keys()).some((k) => k.includes("ROOT"))).toBe(true);
  });

  it("handles deny network", () => {
    const { profile } = buildSeatbeltProfile(minimalConfig);
    expect(profile).toContain("network: denied");
  });

  it("handles allow network", () => {
    const config: SeatbeltConfig = { ...minimalConfig, network: "allow" };
    const { profile } = buildSeatbeltProfile(config);
    expect(profile).toContain("(allow network-outbound)");
    expect(profile).toContain("(allow network-inbound)");
  });

  it("handles allow-loopback network", () => {
    const config: SeatbeltConfig = {
      ...minimalConfig,
      network: "allow-loopback",
      proxyPorts: [8080],
    };
    const { profile } = buildSeatbeltProfile(config);
    expect(profile).toContain("localhost:*");
    expect(profile).toContain("localhost:8080");
  });

  it("includes unix socket policy when enabled", () => {
    const config: SeatbeltConfig = { ...minimalConfig, allowUnixSockets: true };
    const { profile } = buildSeatbeltProfile(config);
    expect(profile).toContain("AF_UNIX");
  });

  it("excludes unix socket policy when disabled", () => {
    const config: SeatbeltConfig = { ...minimalConfig, allowUnixSockets: false };
    const { profile } = buildSeatbeltProfile(config);
    expect(profile).not.toContain("AF_UNIX");
  });
});

describe("wrapWithSeatbelt", () => {
  const config: SeatbeltConfig = {
    writableRoots: [{ path: "/tmp/workspace", access: "write" }],
    readableRoots: [{ path: "/usr", access: "read" }],
    protectedMetadata: [".env"],
    network: "deny",
  };

  it("wraps command with sandbox-exec", () => {
    const result = wrapWithSeatbelt(["git", "status"], config);
    expect(result.command[0]).toBe("/usr/bin/sandbox-exec");
    expect(result.command).toContain("--");
    expect(result.command.slice(-2)).toEqual(["git", "status"]);
  });

  it("includes -f flag with profile file", () => {
    const result = wrapWithSeatbelt(["ls"], config);
    const fIndex = result.command.indexOf("-f");
    expect(fIndex).toBeGreaterThan(0);
    // The -f argument should be a .sbpl file path
    expect(result.command[fIndex + 1]).toMatch(/\.sbpl$/);
  });

  it("includes -D parameter flags", () => {
    const result = wrapWithSeatbelt(["ls"], config);
    expect(result.command).toContain("-D");
  });

  it("returns the profile for inspection", () => {
    const result = wrapWithSeatbelt(["ls"], config);
    expect(result.profile).toContain("(deny default)");
    expect(typeof result.profile).toBe("string");
    expect(result.profile.length).toBeGreaterThan(100);
  });

  it("preserves command arguments", () => {
    const result = wrapWithSeatbelt(["npm", "run", "build", "--verbose"], config);
    const dashIndex = result.command.indexOf("--");
    const originalCmd = result.command.slice(dashIndex + 1);
    expect(originalCmd).toEqual(["npm", "run", "build", "--verbose"]);
  });
});

describe("isSeatbeltAvailable", () => {
  it("returns boolean", () => {
    const result = isSeatbeltAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("is true on macOS", () => {
    // This test is environment-dependent
    if (process.platform === "darwin") {
      expect(isSeatbeltAvailable()).toBe(true);
    }
  });
});

describe("profile generation edge cases", () => {
  it("handles empty writable roots", () => {
    const config: SeatbeltConfig = {
      writableRoots: [],
      readableRoots: [{ path: "/usr", access: "read" }],
      protectedMetadata: [],
      network: "deny",
    };
    const { profile } = buildSeatbeltProfile(config);
    expect(profile).toContain("(deny default)");
    // Should not crash
  });

  it("handles paths with spaces", () => {
    const config: SeatbeltConfig = {
      writableRoots: [{ path: "/tmp/my project dir", access: "write" }],
      readableRoots: [],
      protectedMetadata: [],
      network: "deny",
    };
    const { profile, params } = buildSeatbeltProfile(config);
    expect(profile).toContain("file-write*");
    // Path should be resolved (normalized)
    const paramValues = Array.from(params.values());
    expect(
      paramValues.some((p) => p.includes("my project dir") || p.includes("myprojectdir")),
    ).toBe(true);
  });

  it("handles roots with exclusions", () => {
    const config: SeatbeltConfig = {
      writableRoots: [
        {
          path: "/tmp/workspace",
          access: "write",
          excluded: ["/tmp/workspace/node_modules", "/tmp/workspace/.cache"],
        },
      ],
      readableRoots: [],
      protectedMetadata: [],
      network: "deny",
    };
    const { profile, params } = buildSeatbeltProfile(config);
    expect(profile).toContain("require-not");
    expect(Array.from(params.keys()).some((k) => k.includes("EXCLUDED"))).toBe(true);
  });

  it("handles no protected metadata", () => {
    const config: SeatbeltConfig = {
      writableRoots: [{ path: "/tmp/workspace", access: "write" }],
      readableRoots: [],
      protectedMetadata: [],
      network: "deny",
    };
    const { profile } = buildSeatbeltProfile(config);
    expect(profile).not.toContain("deny file-write* (regex");
  });
});
