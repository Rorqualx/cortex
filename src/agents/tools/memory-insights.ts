/**
 * memory_insights built-in tool.
 *
 * Read-only summary of memory system state: recent L3 snapshots,
 * report counts, and salient topics from the workspace memory directory.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const MemoryInsightsToolSchema = Type.Object({
  limit: Type.Optional(Type.Number({ default: 5, minimum: 1, maximum: 20 })),
  includeTopics: Type.Optional(Type.Boolean({ default: true })),
});

/**
 * Safely list entries in a directory, returning empty array on failure.
 */
async function safeReaddir(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Read the first non-empty lines of a text file for a quick preview.
 */
async function readFilePreview(filePath: string, maxLines = 10): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, maxLines);
  } catch {
    return [];
  }
}

/**
 * Extract topic-like headings from markdown content lines.
 */
function extractTopics(lines: string[]): string[] {
  const topics = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^#{1,3}\s+(.+)$/);
    if (match) {
      topics.add(match[1].trim());
    }
  }
  return [...topics];
}

export function createMemoryInsightsTool(opts?: { workspaceDir?: string }): AnyAgentTool {
  return {
    label: "Memory Insights",
    name: "memory_insights",
    description:
      "Read-only summary of memory system state. Returns recent L3 snapshots, report counts, and salient topics from the workspace memory directory. Does not mutate memory.",
    parameters: MemoryInsightsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.min(20, Math.round(params.limit)))
          : 5;
      const includeTopics = params.includeTopics !== false;

      const workspaceDir = opts?.workspaceDir?.trim() || ".";
      const memoryDir = path.resolve(workspaceDir, "memory");
      const reportsDir = path.join(memoryDir, "reports");
      const l3Dir = path.join(memoryDir, ".l3");

      const reportFiles = (await safeReaddir(reportsDir))
        .filter((f) => f.endsWith(".md"))
        .toSorted((a, b) => b.localeCompare(a));
      const l3Files = (await safeReaddir(l3Dir))
        .filter((f) => f.endsWith(".md"))
        .toSorted((a, b) => b.localeCompare(a));

      const recentReports = reportFiles.slice(0, limit);
      const recentL3 = l3Files.slice(0, limit);

      let topics: string[] = [];
      if (includeTopics) {
        const topicSources = [
          ...recentReports.map((f) => path.join(reportsDir, f)),
          ...recentL3.map((f) => path.join(l3Dir, f)),
        ];
        const allTopics = new Set<string>();
        for (const filePath of topicSources) {
          const lines = await readFilePreview(filePath, 30);
          for (const topic of extractTopics(lines)) {
            allTopics.add(topic);
          }
        }
        topics = [...allTopics].slice(0, 20);
      }

      return jsonResult({
        totalReports: reportFiles.length,
        totalL3Snapshots: l3Files.length,
        recentReports: recentReports.map((f) => ({
          name: f,
          path: path.relative(workspaceDir, path.join(reportsDir, f)),
        })),
        recentL3Snapshots: recentL3.map((f) => ({
          name: f,
          path: path.relative(workspaceDir, path.join(l3Dir, f)),
        })),
        topics: includeTopics ? topics : undefined,
      });
    },
  };
}
