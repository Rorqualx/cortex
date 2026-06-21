// memory-l3 doctor contract: migrates the shipped file-based stores into SQLite.
// The runtime no longer reads the legacy JSON/markdown files, so these imports
// must run (via `openclaw doctor --fix`) before the SQLite-backed engine is used.
//
//   1. shared long-term store  (`<sharedDir>/longterm-shared.json`) -> cross-agent DB
//   2. per-agent tiers         (`<workspace>/.openclaw/l3/*`)        -> per-root `l3.sqlite`
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMemoryDreamingWorkspaces } from "openclaw/plugin-sdk/memory-core-host-status";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import {
  SHARED_STORE_LEGACY_JSON_FILE,
  readSharedFacts,
  resolveSharedMemoryDir,
  writeSharedFacts,
  type SharedLongTermFact,
  type SharedStore,
} from "./src/cross-context.js";
import { Storage } from "./src/storage.js";
import type {
  Entity,
  L2ChunkFrontmatter,
  L3EpochFrontmatter,
  L3State,
  LongTermFrontmatter,
  LongTermTypedFrontmatter,
  MessageChunk,
  RetrievalSignal,
  TopicLink,
} from "./src/types.js";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** Rename a migrated legacy source to `<file>.migrated`, recording the outcome. */
async function archiveFile(params: {
  filePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  if (await fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated memory-l3 ${params.label} in place because ${archivedPath} already exists`,
    );
    return;
  }
  try {
    await fs.rename(params.filePath, archivedPath);
    params.changes.push(`Archived memory-l3 ${params.label} -> ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving memory-l3 ${params.label}: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Migration 1: shared long-term store -> cross-agent SQLite
// ---------------------------------------------------------------------------

function resolveSharedDir(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_SHARED_MEMORY_DIR;
  return resolveSharedMemoryDir(override && override.length > 0 ? override : undefined);
}

function sharedJsonPath(sharedDir: string): string {
  return path.join(sharedDir, SHARED_STORE_LEGACY_JSON_FILE);
}

async function readSharedLegacy(filePath: string): Promise<SharedLongTermFact[]> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as SharedStore;
  return Array.isArray(parsed.facts) ? parsed.facts : [];
}

const sharedStoreMigration: PluginDoctorStateMigration = {
  id: "memory-l3-shared-store-json-to-sqlite",
  label: "memory-l3 shared long-term store",
  async detectLegacyState(params) {
    const filePath = sharedJsonPath(resolveSharedDir(params.env));
    if (!(await fileExists(filePath))) {
      return null;
    }
    return { preview: [`- memory-l3 shared store: ${filePath} -> cross-agent SQLite store`] };
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    const sharedDir = resolveSharedDir(params.env);
    const filePath = sharedJsonPath(sharedDir);
    if (!(await fileExists(filePath))) {
      return { changes, warnings };
    }
    // Idempotency: never overwrite an already-populated SQLite store.
    if ((await readSharedFacts(sharedDir)).length > 0) {
      warnings.push(
        `Skipped memory-l3 shared store import because the SQLite store already has rows; left legacy source in place`,
      );
      return { changes, warnings };
    }
    let facts: SharedLongTermFact[];
    try {
      facts = await readSharedLegacy(filePath);
    } catch (err) {
      warnings.push(
        `Skipped memory-l3 shared store import because the legacy source could not be parsed: ${String(err)}`,
      );
      return { changes, warnings };
    }
    await writeSharedFacts(facts, sharedDir);
    changes.push(
      `Migrated memory-l3 shared store -> cross-agent SQLite store (${facts.length} fact(s))`,
    );
    await archiveFile({ filePath, label: "shared store source", changes, warnings });
    return { changes, warnings };
  },
};

// ---------------------------------------------------------------------------
// Migration 2: per-agent file tiers -> per-root `l3.sqlite`
// ---------------------------------------------------------------------------

/** `state.json` is written on every bootstrap, so it is the migration sentinel. */
const STATE_SENTINEL = "state.json";
/** DB-only legacy indexes (never re-exported); archived after import. */
const ARCHIVED_INDEX_FILES = [
  "state.json",
  "entities.json",
  "topic-links.json",
  "retrieval-signals.json",
  "edges.json",
];

/** L3 root for each configured agent workspace. */
function legacyL3Roots(config: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const entry of resolveMemoryDreamingWorkspaces(config, { env })) {
    const root = path.join(entry.workspaceDir, ".openclaw", "l3");
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }
  return roots;
}

async function readJsonIfExists(filePath: string): Promise<unknown> {
  if (!(await fileExists(filePath))) {
    return null;
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

/** Parse a `---\n<json>\n---\n<body>` tier document; null when malformed/absent. */
async function readDocIfExists(
  filePath: string,
): Promise<{ frontmatter: unknown; body: string } | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }
  const raw = await fs.readFile(filePath, "utf8");
  if (!raw.startsWith("---\n")) {
    return null;
  }
  const closeAt = raw.indexOf("\n---\n", 4);
  if (closeAt < 0) {
    return null;
  }
  try {
    return { frontmatter: JSON.parse(raw.slice(4, closeAt)), body: raw.slice(closeAt + 5) };
  } catch {
    return null;
  }
}

/** List `*.md` files under `dir`; when `nested`, descends one level (date partitions). */
async function listMarkdown(dir: string, nested: boolean): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (nested && entry.isDirectory()) {
      out.push(...(await listMarkdown(path.join(dir, entry.name), false)));
    } else if (!nested && entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Import every legacy tier under `root` into `storage`'s DB. Returns rows written. */
async function importL3Root(storage: Storage, root: string): Promise<number> {
  let count = 0;

  const state = await readJsonIfExists(path.join(root, STATE_SENTINEL));
  if (state && typeof state === "object") {
    await storage.writeState(state as L3State);
    count += 1;
  }

  const longTerm = await readDocIfExists(path.join(root, "longterm.md"));
  if (longTerm) {
    await storage.writeLongTerm(longTerm.frontmatter as LongTermFrontmatter, longTerm.body);
    count += 1;
  }

  const longTermTyped = await readDocIfExists(path.join(root, "longterm-typed.md"));
  if (longTermTyped) {
    await storage.writeLongTermTyped(
      longTermTyped.frontmatter as LongTermTypedFrontmatter,
      longTermTyped.body,
    );
    count += 1;
  }

  for (const filePath of await listMarkdown(path.join(root, "l2"), true)) {
    const doc = await readDocIfExists(filePath);
    if (doc) {
      await storage.writeL2Chunk(doc.frontmatter as L2ChunkFrontmatter, doc.body);
      count += 1;
    }
  }

  for (const filePath of await listMarkdown(path.join(root, "l3"), false)) {
    const doc = await readDocIfExists(filePath);
    if (doc) {
      await storage.writeL3Epoch(doc.frontmatter as L3EpochFrontmatter, doc.body);
      count += 1;
    }
  }

  for (const chunkDir of await listSubdirs(path.join(root, "msg"))) {
    const chunks = await readJsonIfExists(path.join(root, "msg", chunkDir, "chunks.json"));
    if (Array.isArray(chunks) && chunks.length > 0) {
      await storage.writeMessageChunks(chunks as MessageChunk[]);
      count += chunks.length;
    }
  }

  const entities = await readJsonIfExists(path.join(root, "entities.json"));
  if (Array.isArray(entities)) {
    await storage.writeEntityIndex(entities as Entity[]);
    count += entities.length;
  }

  const links = await readJsonIfExists(path.join(root, "topic-links.json"));
  if (Array.isArray(links)) {
    await storage.appendTopicLinks(links as TopicLink[]);
    count += links.length;
  }

  const signals = await readJsonIfExists(path.join(root, "retrieval-signals.json"));
  if (Array.isArray(signals)) {
    await storage.writeRetrievalSignals(signals as RetrievalSignal[]);
    count += signals.length;
  }

  const edges = await readJsonIfExists(path.join(root, "edges.json"));
  if (Array.isArray(edges)) {
    await storage.writeEdgeMap(edges);
    count += edges.length;
  }

  return count;
}

/** Archive the DB-only index files + raw message chunk JSON after a successful import. */
async function archiveL3Indexes(
  root: string,
  changes: string[],
  warnings: string[],
): Promise<void> {
  for (const name of ARCHIVED_INDEX_FILES) {
    const filePath = path.join(root, name);
    if (await fileExists(filePath)) {
      await archiveFile({ filePath, label: `tier index ${name}`, changes, warnings });
    }
  }
  for (const chunkDir of await listSubdirs(path.join(root, "msg"))) {
    const filePath = path.join(root, "msg", chunkDir, "chunks.json");
    if (await fileExists(filePath)) {
      await archiveFile({ filePath, label: `message chunks ${chunkDir}`, changes, warnings });
    }
  }
}

const perAgentMigration: PluginDoctorStateMigration = {
  id: "memory-l3-per-agent-files-to-sqlite",
  label: "memory-l3 per-agent tiers",
  async detectLegacyState(params) {
    const preview: string[] = [];
    for (const root of legacyL3Roots(params.config, params.env)) {
      if (await fileExists(path.join(root, STATE_SENTINEL))) {
        preview.push(`- memory-l3 tiers: ${root} -> ${path.join(root, "l3.sqlite")}`);
      }
    }
    return preview.length > 0 ? { preview } : null;
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    for (const root of legacyL3Roots(params.config, params.env)) {
      if (!(await fileExists(path.join(root, STATE_SENTINEL)))) {
        continue;
      }
      const storage = new Storage(root);
      try {
        // Idempotency is provided by the archived `state.json` sentinel: a
        // completed migration renames it to `.migrated`, so a re-run never
        // reaches here. If the DB ALREADY has chunks while `state.json` is still
        // present, the runtime wrote into the fresh DB before this migration ran
        // (a deploy-runbook violation: doctor --fix must precede the SQLite-backed
        // runtime). We import the legacy tiers ANYWAY rather than skip — skipping
        // here would orphan the on-disk memory permanently. Importing is
        // self-healing (it restores the real long-term memory); warn so the
        // operator can review the brief overlap.
        if ((await storage.listL2ChunkPaths()).length > 0) {
          warnings.push(
            `memory-l3 tiers at ${root}: SQLite store already had chunks before import (runtime wrote before \`openclaw doctor --fix\`?); importing legacy sources anyway to avoid orphaning them`,
          );
        }
        let imported: number;
        try {
          imported = await importL3Root(storage, root);
        } catch (err) {
          warnings.push(
            `Skipped memory-l3 tiers import for ${root} because a legacy source could not be imported: ${String(err)}`,
          );
          continue;
        }
        changes.push(`Migrated memory-l3 tiers at ${root} -> l3.sqlite (${imported} row(s))`);
        await archiveL3Indexes(root, changes, warnings);
      } finally {
        storage.close();
      }
    }
    return { changes, warnings };
  },
};

export const stateMigrations: PluginDoctorStateMigration[] = [
  sharedStoreMigration,
  perAgentMigration,
];
