// Renders memory-l3's seven ZenBrain layers as human-readable markdown for the
// Control UI "Layers" viewer. This READS L3's documented on-disk display
// artifacts (the markdown exports + l1 replay jsonl under
// `<workspace>/.openclaw/l3/`, and the cross-agent `longterm-shared.sqlite`) plus
// skill-forge's `SKILL.md` files — a read-only display coupling, not a code
// import across the plugin boundary. The artifact layout is the contract
// documented in `extensions/memory-l3/AGENTS.md`; if it changes, update here.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { normalizeAgentId } from "../../routing/session-key.js";

export type L3LayerDescriptor = {
  id: string;
  label: string;
  description: string;
};

/** The seven ZenBrain layers, ordered raw → consolidated → shared. */
export const L3_LAYERS: L3LayerDescriptor[] = [
  { id: "l1", label: "L1 · Raw archive", description: "Sliding-window message chunks (replay)" },
  { id: "l2", label: "L2 · Summary chunks", description: "LLM-distilled facts per session" },
  { id: "l3", label: "L3 · Epoch digests", description: "Roll-ups across consecutive L2 chunks" },
  { id: "longterm", label: "Long-term · Prose", description: "Evergreen consolidated facts" },
  {
    id: "longterm-typed",
    label: "Long-term · Typed",
    description: "Canonical slot values + history",
  },
  { id: "procedural", label: "Procedural", description: "Promoted skills (skill-forge)" },
  { id: "shared", label: "Cross-context · Shared", description: "Facts shared across agents" },
];

const L3_LAYER_IDS = new Set(L3_LAYERS.map((layer) => layer.id));

/** Cap per-layer markdown so the viewer payload stays bounded. */
const MAX_LAYER_CHARS = 200_000;
/** Cap how many recent files/rows a multi-item layer renders. */
const MAX_ITEMS = 40;

export function isL3LayerId(value: unknown): value is string {
  return typeof value === "string" && L3_LAYER_IDS.has(value);
}

function l3Root(cfg: OpenClawConfig, agentId: string): string {
  return path.join(resolveAgentWorkspaceDir(cfg, agentId), ".openclaw", "l3");
}

function sharedStoreDbPath(): string {
  const override = process.env.OPENCLAW_SHARED_MEMORY_DIR;
  const dir =
    override && override.length > 0
      ? override
      : path.join(os.homedir(), ".openclaw", "shared-memory");
  return path.join(dir, "longterm-shared.sqlite");
}

function skillForgeDir(): string {
  const override = process.env.OPENCLAW_SKILL_FORGE_DIR;
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), ".openclaw", "skill-forge", "skills");
}

/** Strip the JSON frontmatter fence, returning the human-readable body. */
function stripFrontmatter(raw: string): string {
  if (raw.startsWith("---\n")) {
    const close = raw.indexOf("\n---\n", 4);
    if (close >= 0) {
      return raw.slice(close + 5).trim();
    }
  }
  return raw.trim();
}

function clamp(markdown: string): string {
  if (markdown.length <= MAX_LAYER_CHARS) {
    return markdown;
  }
  return `${markdown.slice(0, MAX_LAYER_CHARS)}\n\n_… truncated (layer exceeds ${MAX_LAYER_CHARS} chars)._`;
}

async function readBodyExport(file: string): Promise<string | null> {
  try {
    return stripFrontmatter(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Recursively list `*.md` files under `dir`, newest first by name (ids sort chronologically). */
async function listMarkdownNewestFirst(dir: string, recursive: boolean): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (recursive && entry.isDirectory()) {
      files.push(...(await listMarkdownNewestFirst(path.join(dir, entry.name), false)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.join(dir, entry.name));
    }
  }
  // Tokens embed zero-padded sequence / dates, so reverse-lexical ≈ newest first.
  return files.toSorted((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** Render the most-recent chunk/epoch markdown bodies, each under an id heading. */
async function renderChunkExports(
  dir: string,
  recursive: boolean,
  emptyNote: string,
): Promise<string> {
  const files = (await listMarkdownNewestFirst(dir, recursive)).slice(0, MAX_ITEMS);
  if (files.length === 0) {
    return emptyNote;
  }
  const sections: string[] = [];
  let total = 0;
  for (const file of files) {
    // Stop reading once we have enough to fill the clamp budget, so peak memory
    // is bounded by MAX_LAYER_CHARS rather than MAX_ITEMS × max-file-size.
    if (total >= MAX_LAYER_CHARS) {
      break;
    }
    const body = await readBodyExport(file);
    if (body !== null) {
      total += body.length;
      sections.push(`## ${path.basename(file, ".md")}\n\n${body}`);
    }
  }
  return sections.join("\n\n---\n\n");
}

/** Render a compact summary of the raw L1 replay archive (jsonl is verbose). */
async function renderL1Archive(dir: string): Promise<string> {
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return "_No raw archive yet._";
  }
  if (files.length === 0) {
    return "_No raw archive yet._";
  }
  const recent = files.toSorted((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, MAX_ITEMS);
  const lines: string[] = [
    `_${files.length} archived message-chunk file(s); showing ${recent.length} most recent._\n`,
  ];
  for (const name of recent) {
    let entryCount = 0;
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf8");
      entryCount = raw.split("\n").filter((line) => line.trim().length > 0).length;
    } catch {
      // Skip unreadable files defensively.
    }
    lines.push(`- \`${name.replace(/\.jsonl$/, "")}\` — ${entryCount} message(s)`);
  }
  return lines.join("\n");
}

/** Render promoted skill-forge skills (procedural memory). */
async function renderProcedural(dir: string): Promise<string> {
  let skillDirs: string[];
  try {
    skillDirs = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return "_No promoted skills yet._";
  }
  if (skillDirs.length === 0) {
    return "_No promoted skills yet._";
  }
  const sections: string[] = [];
  for (const name of skillDirs.toSorted().slice(0, MAX_ITEMS)) {
    // readBodyExport already strips frontmatter; do not strip twice (a body that
    // legitimately starts with `---` would lose content).
    const body = (await readBodyExport(path.join(dir, name, "SKILL.md"))) ?? "";
    sections.push(`## ${name}\n\n${body || "_(no SKILL.md body)_"}`);
  }
  return sections.join("\n\n---\n\n");
}

type SharedFactRow = {
  text?: unknown;
  dedupKey?: unknown;
  importance?: unknown;
  sourceAgentId?: unknown;
  archived?: unknown;
};

/** Render the cross-agent shared store (SQLite-only) to a markdown fact list. */
function renderSharedStore(dbPath: string): string {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = requireNodeSqlite());
  } catch {
    return "_SQLite unavailable in this runtime._";
  }
  let db: import("node:sqlite").DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return "_No cross-context shared facts yet._";
  }
  try {
    // Bound the read in SQL: only active rows, highest-importance first, capped.
    // The `archived` column is authoritative; importance lives in the JSON payload.
    const rows = db
      .prepare(
        "SELECT payload FROM l3_shared_longterm WHERE archived = 0 " +
          "ORDER BY json_extract(payload, '$.importance') DESC LIMIT ?",
      )
      .all(MAX_ITEMS * 5) as Array<{ payload: string }>;
    const active: SharedFactRow[] = [];
    for (const row of rows) {
      try {
        active.push(JSON.parse(row.payload) as SharedFactRow);
      } catch {
        // Skip a corrupt row rather than failing the whole layer.
      }
    }
    if (active.length === 0) {
      return "_No cross-context shared facts yet._";
    }
    const lines = active.map((fact) => {
      const importance = Number(fact.importance ?? 0).toFixed(2);
      const agent = typeof fact.sourceAgentId === "string" ? fact.sourceAgentId : "?";
      const key = typeof fact.dedupKey === "string" ? fact.dedupKey : "?";
      const text = typeof fact.text === "string" ? fact.text : "";
      return `- [${importance}] \`${key}\` _(${agent})_ — ${text}`;
    });
    return `_Showing ${active.length} shared fact(s), highest importance first._\n\n${lines.join("\n")}`;
  } finally {
    try {
      db.close();
    } catch {
      // best-effort close
    }
  }
}

/** Layers that are global (not workspace-scoped); rendered once even in "all" mode. */
const GLOBAL_LAYER_IDS = new Set(["procedural", "shared"]);

/** Render a workspace-scoped layer rooted at one L3 root. */
async function renderLayerForRoot(root: string, layerId: string): Promise<string> {
  switch (layerId) {
    case "l1":
      return renderL1Archive(path.join(root, "l1_archive"));
    case "l2":
      return renderChunkExports(path.join(root, "l2"), true, "_No summary chunks yet._");
    case "l3":
      return renderChunkExports(path.join(root, "l3"), false, "_No epoch digests yet._");
    case "longterm":
      return (
        (await readBodyExport(path.join(root, "longterm.md"))) ?? "_No long-term prose facts yet._"
      );
    case "longterm-typed":
      return (
        (await readBodyExport(path.join(root, "longterm-typed.md"))) ?? "_No typed facts yet._"
      );
    default:
      return "_Unknown layer._";
  }
}

/** Render a global (cross-agent) layer. */
async function renderGlobalLayer(layerId: string): Promise<string> {
  if (layerId === "procedural") {
    return renderProcedural(skillForgeDir());
  }
  if (layerId === "shared") {
    return renderSharedStore(sharedStoreDbPath());
  }
  return "_Unknown layer._";
}

/** Distinct L3 roots across all configured agents (agents often share a workspace). */
function uniqueL3Roots(cfg: OpenClawConfig): string[] {
  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry.id !== "string") {
      continue;
    }
    const root = l3Root(cfg, normalizeAgentId(entry.id));
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }
  return roots;
}

/** Render one ZenBrain layer for a single agent. */
export async function renderL3Layer(
  cfg: OpenClawConfig,
  agentId: string,
  layerId: string,
): Promise<string> {
  if (GLOBAL_LAYER_IDS.has(layerId)) {
    return clamp(await renderGlobalLayer(layerId));
  }
  return clamp(await renderLayerForRoot(l3Root(cfg, agentId), layerId));
}

/** Render one ZenBrain layer aggregated across every agent's workspace. */
export async function renderL3LayerForAllAgents(
  cfg: OpenClawConfig,
  layerId: string,
): Promise<string> {
  if (GLOBAL_LAYER_IDS.has(layerId)) {
    return clamp(await renderGlobalLayer(layerId));
  }
  const roots = uniqueL3Roots(cfg);
  if (roots.length <= 1) {
    return clamp(await renderLayerForRoot(roots[0] ?? l3Root(cfg, ""), layerId));
  }
  const sections: string[] = [];
  for (const root of roots) {
    sections.push(`# ${root}\n\n${await renderLayerForRoot(root, layerId)}`);
  }
  return clamp(sections.join("\n\n---\n\n"));
}
