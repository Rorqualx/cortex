// memory_reports tests cover read-only memory-directory summaries from a workspace.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createMemoryReportsTool } from "./memory-reports.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

type MemoryReportsDetails = {
  totalReports: number;
  totalL3Snapshots: number;
  recentReports: Array<{ name: string; path: string }>;
  recentL3Snapshots: Array<{ name: string; path: string }>;
  topics?: string[];
};

async function runTool(
  workspaceDir: string,
  args: Record<string, unknown> = {},
): Promise<MemoryReportsDetails> {
  const tool = createMemoryReportsTool({ workspaceDir });
  const result = await tool.execute("call-memory-reports", args);
  return result.details as MemoryReportsDetails;
}

async function writeMemoryFile(workspaceDir: string, relPath: string, content: string) {
  const filePath = path.join(workspaceDir, relPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

describe("memory_reports tool", () => {
  it("returns empty state when the memory directory is missing", async () => {
    const workspaceDir = await tempDirs.make("openclaw-memory-reports-");

    const details = await runTool(workspaceDir);

    expect(details).toEqual({
      totalReports: 0,
      totalL3Snapshots: 0,
      recentReports: [],
      recentL3Snapshots: [],
      topics: [],
    });
  });

  it("counts reports and L3 snapshots with newest-first relative paths", async () => {
    const workspaceDir = await tempDirs.make("openclaw-memory-reports-");
    await writeMemoryFile(workspaceDir, "memory/reports/2026-06-01-alpha.md", "# Alpha");
    await writeMemoryFile(workspaceDir, "memory/reports/2026-06-03-gamma.md", "# Gamma");
    await writeMemoryFile(workspaceDir, "memory/reports/2026-06-02-beta.md", "# Beta");
    await writeMemoryFile(workspaceDir, "memory/.l3/2026-06-04-snap.md", "# Snapshot");
    await writeMemoryFile(workspaceDir, "memory/reports/notes.txt", "not markdown");

    const details = await runTool(workspaceDir);

    expect(details.totalReports).toBe(3);
    expect(details.totalL3Snapshots).toBe(1);
    expect(details.recentReports.map((r) => r.name)).toEqual([
      "2026-06-03-gamma.md",
      "2026-06-02-beta.md",
      "2026-06-01-alpha.md",
    ]);
    expect(details.recentReports[0]?.path).toBe(
      path.join("memory", "reports", "2026-06-03-gamma.md"),
    );
    expect(details.recentL3Snapshots).toEqual([
      { name: "2026-06-04-snap.md", path: path.join("memory", ".l3", "2026-06-04-snap.md") },
    ]);
  });

  it("limits recent entries while keeping total counts", async () => {
    const workspaceDir = await tempDirs.make("openclaw-memory-reports-");
    for (let i = 1; i <= 4; i++) {
      await writeMemoryFile(workspaceDir, `memory/reports/2026-06-0${i}.md`, `# Report ${i}`);
    }

    const details = await runTool(workspaceDir, { limit: 2 });

    expect(details.totalReports).toBe(4);
    expect(details.recentReports.map((r) => r.name)).toEqual(["2026-06-04.md", "2026-06-03.md"]);
  });

  it("clamps out-of-range limit values instead of failing", async () => {
    const workspaceDir = await tempDirs.make("openclaw-memory-reports-");
    await writeMemoryFile(workspaceDir, "memory/reports/2026-06-01.md", "# Report");

    const details = await runTool(workspaceDir, { limit: -5 });

    expect(details.recentReports).toHaveLength(1);
  });

  it("extracts deduped heading topics from recent reports and snapshots", async () => {
    const workspaceDir = await tempDirs.make("openclaw-memory-reports-");
    await writeMemoryFile(
      workspaceDir,
      "memory/reports/2026-06-01.md",
      "# Build Failures\n\n## Gateway Restart\n\nbody text\n\n#### too deep\n",
    );
    await writeMemoryFile(
      workspaceDir,
      "memory/.l3/2026-06-02.md",
      "# Build Failures\n\n### Cron Repin\n",
    );

    const details = await runTool(workspaceDir);

    expect(details.topics).toEqual(
      expect.arrayContaining(["Build Failures", "Gateway Restart", "Cron Repin"]),
    );
    // Deduped across files and capped at h1-h3 headings.
    expect(details.topics?.filter((t) => t === "Build Failures")).toHaveLength(1);
    expect(details.topics).not.toContain("too deep");
  });

  it("omits topics when includeTopics is false", async () => {
    const workspaceDir = await tempDirs.make("openclaw-memory-reports-");
    await writeMemoryFile(workspaceDir, "memory/reports/2026-06-01.md", "# Topic Heading");

    const details = await runTool(workspaceDir, { includeTopics: false });

    expect(details.topics).toBeUndefined();
  });
});
