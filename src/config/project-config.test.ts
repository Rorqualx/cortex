/**
 * Tests for multi-layer project config discovery, filtering, and merging.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCache,
  deepMerge,
  discoverProjectRoot,
  filterProjectFields,
  loadProjectConfig,
  validateProjectConfig,
} from "./project-config.js";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-config-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("discoverProjectRoot", () => {
  afterEach(() => clearCache());

  it("returns null when no .openclaw.json exists", async () => {
    await withTempDir(async (dir) => {
      expect(discoverProjectRoot(dir)).toBeNull();
    });
  });

  it("returns cwd when .openclaw.json exists in cwd", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, ".openclaw.json"), "{}");
      expect(discoverProjectRoot(dir)).toBe(dir);
    });
  });

  it("returns parent when .openclaw.json exists in parent", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, ".openclaw.json"), "{}");
      const child = path.join(dir, "sub");
      await fs.mkdir(child);
      expect(discoverProjectRoot(child)).toBe(dir);
    });
  });

  it("skips ~/.openclaw/ directory", async () => {
    await withTempDir(async (dir) => {
      const openclawDir = path.join(dir, ".openclaw");
      await fs.mkdir(openclawDir);
      await fs.writeFile(path.join(openclawDir, ".openclaw.json"), "{}");
      // Should NOT find the one inside .openclaw/
      expect(discoverProjectRoot(dir)).toBeNull();
    });
  });
});

describe("filterProjectFields", () => {
  it("allows agents.defaults.model", () => {
    const result = filterProjectFields({ agents: { defaults: { model: "gpt-4" } } });
    expect(result).toEqual({ agents: { defaults: { model: "gpt-4" } } });
  });

  it("allows nested agents.defaults.sandbox.docker.image", () => {
    const result = filterProjectFields({
      agents: { defaults: { sandbox: { docker: { image: "ubuntu" } } } },
    });
    expect(result).toEqual({
      agents: { defaults: { sandbox: { docker: { image: "ubuntu" } } } },
    });
  });

  it("strips gateway.* fields", () => {
    expect(filterProjectFields({ gateway: { port: 8080 } })).toEqual({});
  });

  it("strips channels.* fields", () => {
    expect(filterProjectFields({ channels: { slack: { token: "x" } } })).toEqual({});
  });

  it("strips secrets.* fields", () => {
    expect(filterProjectFields({ secrets: { apiKey: "secret" } })).toEqual({});
  });

  it("allows logging.level", () => {
    expect(filterProjectFields({ logging: { level: "debug" } })).toEqual({
      logging: { level: "debug" },
    });
  });

  it("allows mcp.servers", () => {
    const input = { mcp: { servers: [{ name: "test" }] } };
    expect(filterProjectFields(input)).toEqual(input);
  });

  it("allows ui with arbitrary nested fields", () => {
    const input = { ui: { theme: "dark", colors: { primary: "#fff" } } };
    expect(filterProjectFields(input)).toEqual(input);
  });

  it("returns empty object when all fields forbidden", () => {
    expect(filterProjectFields({ gateway: {}, secrets: {}, channels: {} })).toEqual({});
  });

  it("keeps allowed fields and strips forbidden in same object", () => {
    const result = filterProjectFields({
      agents: { defaults: { model: "gpt-4" } },
      gateway: { port: 8080 },
    });
    expect(result).toEqual({ agents: { defaults: { model: "gpt-4" } } });
  });
});

describe("deepMerge", () => {
  it("merges flat objects", () => {
    expect(deepMerge({ a: 1, b: 2 }, { c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("deep merges nested objects", () => {
    expect(
      deepMerge({ outer: { inner: 1, other: "a" } }, { outer: { inner: 2, extra: "b" } }),
    ).toEqual({ outer: { inner: 2, other: "a", extra: "b" } });
  });

  it("arrays replace (not concatenate)", () => {
    expect(deepMerge({ list: [1, 2] }, { list: [3] })).toEqual({ list: [3] });
  });

  it("later values win", () => {
    expect(deepMerge({ key: "first" }, { key: "second" })).toEqual({ key: "second" });
  });

  it("skips null and undefined overrides", () => {
    expect(deepMerge({ a: 1 }, null, undefined, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("handles three-way merge", () => {
    expect(deepMerge({ a: 1 }, { b: 2 }, { a: 3 })).toEqual({ a: 3, b: 2 });
  });
});

describe("validateProjectConfig", () => {
  it("parses valid JSON5", () => {
    expect(validateProjectConfig('{ "key": "value" }', "test")).toEqual({ key: "value" });
  });

  it("throws on invalid JSON5", () => {
    expect(() => validateProjectConfig("{ invalid }", "test")).toThrow(/Invalid project config/);
  });

  it("throws on array", () => {
    expect(() => validateProjectConfig("[1,2,3]", "test")).toThrow(/JSON object/);
  });

  it("throws on string", () => {
    expect(() => validateProjectConfig('"hello"', "test")).toThrow(/JSON object/);
  });

  it("accepts JSON5 with comments", () => {
    expect(validateProjectConfig('{ // comment\n "key": "value" }', "test")).toEqual({
      key: "value",
    });
  });
});

describe("loadProjectConfig", () => {
  afterEach(() => clearCache());

  it("returns null when projectRoot is empty", () => {
    const result = loadProjectConfig("", {});
    expect(result.projectRoot).toBeNull();
    expect(result.mergedConfig).toBeNull();
  });

  it("merges global + project shared config", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, ".openclaw.json"),
        JSON.stringify({ agents: { defaults: { model: "project-model" } } }),
      );
      const result = loadProjectConfig(dir, { agents: { defaults: { model: "global-model" } } });
      expect(result.sources.shared).toBe(true);
      expect((result.mergedConfig as any).agents.defaults.model).toBe("project-model");
    });
  });

  it("merges global + shared + local with local winning", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, ".openclaw.json"),
        JSON.stringify({ agents: { defaults: { model: "shared" } } }),
      );
      await fs.writeFile(
        path.join(dir, ".openclaw.local.json"),
        JSON.stringify({ agents: { defaults: { model: "local" } } }),
      );
      const result = loadProjectConfig(dir, {
        agents: { defaults: { model: "global" } },
      });
      expect(result.sources.shared).toBe(true);
      expect(result.sources.local).toBe(true);
      expect((result.mergedConfig as any).agents.defaults.model).toBe("local");
    });
  });

  it("strips forbidden fields from project config", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, ".openclaw.json"),
        JSON.stringify({
          agents: { defaults: { model: "safe" } },
          gateway: { port: 9999 },
          secrets: { key: "stolen" },
        }),
      );
      const result = loadProjectConfig(dir, {});
      expect((result.mergedConfig as any).agents.defaults.model).toBe("safe");
      expect((result.mergedConfig as any).gateway).toBeUndefined();
      expect((result.mergedConfig as any).secrets).toBeUndefined();
    });
  });

  it("preserves global fields not overridden", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, ".openclaw.json"),
        JSON.stringify({ logging: { level: "debug" } }),
      );
      const result = loadProjectConfig(dir, {
        agents: { defaults: { model: "global" } },
        otherField: "kept",
      });
      expect((result.mergedConfig as any).agents.defaults.model).toBe("global");
      expect((result.mergedConfig as any).otherField).toBe("kept");
      expect((result.mergedConfig as any).logging.level).toBe("debug");
    });
  });
});
