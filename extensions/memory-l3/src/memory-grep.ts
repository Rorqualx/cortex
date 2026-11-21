/**
 * Read-only lossless-recall fallback (GrepMem — adopted strictly as a fallback
 * tier + audit instrument, NOT an embeddings/index replacement): bounded regex
 * search over the raw L1 archive (`l1_archive/*.jsonl`, the append-only replay
 * artifact and only lossless record of every message that entered the engine)
 * plus the workspace memory markdown (`memory/*.md`). Use when structured
 * recall misses — exact strings (IPs, error codes, identifiers) that the
 * tiered pipeline may have dropped or reworded.
 *
 * Bounds keep the tool audit-grade safe: first match per line (grep
 * semantics), per-source file cap, wall-clock budget, per-line byte cap, and
 * total snippet budget. Patterns are compiled with the standard RegExp
 * constructor — keep patterns simple (no nested quantifiers); like the rest
 * of the fork's regex discipline, exotic patterns are the caller's problem.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { Storage } from "./storage.js";

const MAX_PATTERN_CHARS = 200;
const MAX_FILES_PER_SOURCE = 1_000;
/** Skip lines longer than this — bounds both memory and regex exposure. */
const MAX_LINE_BYTES = 262_144;
const WALL_CLOCK_BUDGET_MS = 5_000;
const SNIPPET_CONTEXT_CHARS = 120;
const MAX_TOTAL_SNIPPET_CHARS = 16_384;

const MemoryGrepToolSchema = Type.Object(
  {
    pattern: Type.String({
      description:
        "Regex source to search for (no surrounding slashes; flags via ignoreCase). Keep it simple — nested quantifiers are not timeboxed.",
      maxLength: 200,
    }),
    source: Type.Optional(
      Type.Union([Type.Literal("archive"), Type.Literal("memory"), Type.Literal("both")], {
        description:
          "Where to search: 'archive' = raw L1 message archive (l1_archive/*.jsonl), 'memory' = workspace memory markdown (memory/*.md), 'both' (default).",
      }),
    ),
    ignoreCase: Type.Optional(
      Type.Boolean({ description: "Case-insensitive matching (default false)." }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: "Max match records to return (default 20, max 100).",
        minimum: 1,
        maximum: 100,
      }),
    ),
  },
  { additionalProperties: false },
);

export type MemoryGrepMatch = {
  source: "archive" | "memory";
  file: string;
  line: number;
  snippet: string;
};

export type MemoryGrepResult = {
  generatedAt: number;
  pattern: string;
  ignoreCase: boolean;
  source: "archive" | "memory" | "both";
  counts: {
    archiveFilesTotal: number;
    archiveFilesScanned: number;
    memoryFilesTotal: number;
    memoryFilesScanned: number;
  };
  stoppedEarly: null | "limit" | "snippet-budget" | "deadline";
  matches: MemoryGrepMatch[];
};

/** List `*.jsonl`/`*.md` files in a directory, newest first, capped. */
async function listFilesNewestFirst(
  dir: string,
  suffix: string,
  cap: number,
): Promise<{ files: string[]; total: number }> {
  let entries: Array<{ name: string; mtimeMs: number }>;
  try {
    entries = await Promise.all(
      (await fsp.readdir(dir))
        .filter((name) => name.endsWith(suffix))
        .map(async (name) => {
          const st = await fsp.stat(path.join(dir, name)).catch(() => null);
          return { name, mtimeMs: st?.mtimeMs ?? 0 };
        }),
    );
  } catch {
    return { files: [], total: 0 };
  }
  const sorted = entries.sort((a, b) => b.mtimeMs - a.mtimeMs).map((e) => e.name);
  return { files: sorted.slice(0, cap), total: sorted.length };
}

function snippetAround(line: string, index: number): string {
  const start = Math.max(0, index - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(line.length, index + SNIPPET_CONTEXT_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < line.length ? "…" : "";
  return prefix + line.slice(start, end) + suffix;
}

/** Core scan, shared with tests. Scans the given sources and returns matches. */
export async function grepMemory(params: {
  workspaceDir: string | undefined;
  pattern: string;
  source?: "archive" | "memory" | "both";
  ignoreCase?: boolean;
  limit?: number;
  now?: number;
}): Promise<MemoryGrepResult | { error: string; message: string }> {
  if (params.pattern.length > MAX_PATTERN_CHARS) {
    return { error: "pattern_too_long", message: `pattern exceeds ${MAX_PATTERN_CHARS} chars` };
  }
  let re: RegExp;
  try {
    re = new RegExp(params.pattern, params.ignoreCase ? "i" : "");
  } catch (err) {
    return { error: "invalid_regex", message: err instanceof Error ? err.message : String(err) };
  }
  const source = params.source ?? "both";
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  // Wall-clock budget is inherently real-time; `now` only pins generatedAt
  // for deterministic tests — never mix the two.
  const deadline = Date.now() + WALL_CLOCK_BUDGET_MS;

  const result: MemoryGrepResult = {
    generatedAt: params.now ?? Date.now(),
    pattern: params.pattern,
    ignoreCase: params.ignoreCase === true,
    source,
    counts: {
      archiveFilesTotal: 0,
      archiveFilesScanned: 0,
      memoryFilesTotal: 0,
      memoryFilesScanned: 0,
    },
    stoppedEarly: null,
    matches: [],
  };
  let snippetBudget = MAX_TOTAL_SNIPPET_CHARS;

  const scanSource = async (
    kind: "archive" | "memory",
    dir: string | undefined,
    suffix: string,
  ): Promise<void> => {
    if (!dir || result.stoppedEarly) {
      return;
    }
    const { files, total } = await listFilesNewestFirst(dir, suffix, MAX_FILES_PER_SOURCE);
    result.counts[kind === "archive" ? "archiveFilesTotal" : "memoryFilesTotal"] = total;
    for (const name of files) {
      if (result.stoppedEarly) {
        return;
      }
      let text: string;
      try {
        text = await fsp.readFile(path.join(dir, name), "utf8");
      } catch {
        continue; // Unreadable file — skip, never fail the whole scan.
      }
      result.counts[kind === "archive" ? "archiveFilesScanned" : "memoryFilesScanned"] += 1;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.length === 0 || line.length > MAX_LINE_BYTES) {
          continue;
        }
        if (Date.now() > deadline) {
          result.stoppedEarly = "deadline";
          return;
        }
        const m = re.exec(line);
        if (!m || m.index === undefined) {
          continue;
        }
        const snippet = snippetAround(line, m.index);
        result.matches.push({ source: kind, file: name, line: i + 1, snippet });
        snippetBudget -= snippet.length;
        if (result.matches.length >= limit) {
          result.stoppedEarly = "limit";
          return;
        }
        if (snippetBudget <= 0) {
          result.stoppedEarly = "snippet-budget";
          return;
        }
      }
    }
  };

  if (source === "archive" || source === "both") {
    const l3Root = Storage.fromWorkspace(params.workspaceDir).root;
    await scanSource("archive", path.join(l3Root, "l1_archive"), ".jsonl");
  }
  if (source === "memory" || source === "both") {
    await scanSource(
      "memory",
      params.workspaceDir ? path.join(params.workspaceDir, "memory") : undefined,
      ".md",
    );
  }
  return result;
}

export function createMemoryGrepTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "memory_grep",
    label: "Memory Grep",
    description:
      "Read-only lossless recall fallback: bounded regex search over the raw L1 message archive (l1_archive/*.jsonl) and workspace memory markdown (memory/*.md). Use when structured recall (memory_search/retrieval) misses — exact strings like IPs, error codes, or identifiers that the tiered pipeline may have dropped or reworded. Not a replacement for semantic recall.",
    parameters: MemoryGrepToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const pattern = typeof rawParams.pattern === "string" ? rawParams.pattern : "";
      const source =
        rawParams.source === "archive" ||
        rawParams.source === "memory" ||
        rawParams.source === "both"
          ? rawParams.source
          : undefined;
      const ignoreCase = rawParams.ignoreCase === true;
      const limit = typeof rawParams.limit === "number" ? rawParams.limit : undefined;
      const outcome = await grepMemory({
        workspaceDir: ctx.workspaceDir,
        pattern,
        source,
        ignoreCase,
        limit,
      });
      return jsonResult(outcome);
    },
  };
}
