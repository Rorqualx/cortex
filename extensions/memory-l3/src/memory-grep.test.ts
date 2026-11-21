// memory_grep tool tests: bounded regex recall over a seeded temp workspace
// (l1_archive JSONL + memory markdown), limit/truncation semantics, source
// filtering, and invalid-pattern error handling.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryGrepTool, grepMemory } from "./memory-grep.js";

const NOW = Date.parse("2026-11-21T13:00:00Z");

function ctxFor(workspaceDir: string): OpenClawPluginToolContext {
  return { workspaceDir } as OpenClawPluginToolContext;
}

async function seedWorkspace(root: string): Promise<void> {
  const archive = path.join(root, ".openclaw", "l3", "l1_archive");
  await fsp.mkdir(archive, { recursive: true });
  await fsp.mkdir(path.join(root, "memory"), { recursive: true });
  // chunk-a: two lines, one carrying the exact identifier to find.
  await fsp.writeFile(
    path.join(archive, "chunk-a.jsonl"),
    [
      JSON.stringify({ role: "user", content: "what was the pi-hole ip again?" }),
      JSON.stringify({ role: "assistant", content: "pi-hole is at 192.168.50.128" }),
      "",
    ].join("\n"),
  );
  // chunk-b: no match.
  await fsp.writeFile(
    path.join(archive, "chunk-b.jsonl"),
    [JSON.stringify({ role: "user", content: "hello there" }), ""].join("\n"),
  );
  await fsp.writeFile(
    path.join(root, "memory", "notes.md"),
    "# Notes\n\nDDNS host: rorqualx.asuscomm.com on the 192.168.50.128 node\n",
  );
}

describe("memory_grep", () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "memory-l3-grep-"));
    await seedWorkspace(root);
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("finds exact-string matches across archive and memory sources", async () => {
    const result = await grepMemory({
      workspaceDir: root,
      pattern: "192\\.168\\.50\\.128",
      now: NOW,
    });
    expect("error" in result && result.error).toBeFalsy();
    if ("error" in result) {
      throw new Error(result.message);
    }
    expect(result.matches).toHaveLength(2);
    const sources = result.matches.map((m) => m.source).sort();
    expect(sources).toEqual(["archive", "memory"]);
    const archiveMatch = result.matches.find((m) => m.source === "archive");
    expect(archiveMatch?.file).toBe("chunk-a.jsonl");
    expect(archiveMatch?.line).toBe(2);
    expect(archiveMatch?.snippet).toContain("192.168.50.128");
    expect(result.stoppedEarly).toBeNull();
    expect(result.counts.archiveFilesTotal).toBe(2);
    expect(result.counts.archiveFilesScanned).toBe(2);
    expect(result.counts.memoryFilesScanned).toBe(1);
  });

  it("stops at limit and reports it", async () => {
    const result = await grepMemory({
      workspaceDir: root,
      pattern: "192\\.168\\.50\\.128",
      limit: 1,
      now: NOW,
    });
    if ("error" in result) {
      throw new Error(result.message);
    }
    expect(result.matches).toHaveLength(1);
    expect(result.stoppedEarly).toBe("limit");
  });

  it("restricts to the requested source", async () => {
    const result = await grepMemory({
      workspaceDir: root,
      pattern: "rorqualx",
      source: "memory",
      now: NOW,
    });
    if ("error" in result) {
      throw new Error(result.message);
    }
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].source).toBe("memory");
    expect(result.counts.archiveFilesScanned).toBe(0);
    expect(result.counts.archiveFilesTotal).toBe(0);
  });

  it("applies ignoreCase", async () => {
    const sensitive = await grepMemory({
      workspaceDir: root,
      pattern: "RORQUALX",
      now: NOW,
    });
    if ("error" in sensitive) {
      throw new Error(sensitive.message);
    }
    expect(sensitive.matches).toHaveLength(0);
    const insensitive = await grepMemory({
      workspaceDir: root,
      pattern: "RORQUALX",
      ignoreCase: true,
      now: NOW,
    });
    if ("error" in insensitive) {
      throw new Error(insensitive.message);
    }
    expect(insensitive.matches).toHaveLength(1);
    expect(insensitive.ignoreCase).toBe(true);
  });

  it("returns a structured error for an invalid regex", async () => {
    const result = await grepMemory({
      workspaceDir: root,
      pattern: "([unclosed",
      now: NOW,
    });
    expect("error" in result && result.error).toBe("invalid_regex");
  });

  it("rejects over-long patterns", async () => {
    const result = await grepMemory({
      workspaceDir: root,
      pattern: "a".repeat(201),
      now: NOW,
    });
    expect("error" in result && result.error).toBe("pattern_too_long");
  });

  it("tool wiring returns the scan as JSON details", async () => {
    const tool = createMemoryGrepTool(ctxFor(root));
    expect(tool.name).toBe("memory_grep");
    const raw = await tool.execute("t1", { pattern: "pi-hole", ignoreCase: true });
    expect(raw.details).toMatchObject({
      pattern: "pi-hole",
      ignoreCase: true,
      source: "both",
    });
    const details = raw.details as { matches: Array<{ source: string }> };
    expect(details.matches.length).toBeGreaterThan(0);
  });
});
