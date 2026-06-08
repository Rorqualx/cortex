import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  type FrontmatterDocument,
  INITIAL_L3_STATE,
  INITIAL_LONG_TERM_FRONTMATTER,
  INITIAL_LONG_TERM_TYPED_FRONTMATTER,
  type L2ChunkFrontmatter,
  type L3EpochFrontmatter,
  type L3State,
  type LongTermFrontmatter,
  type LongTermTypedFrontmatter,
  type MessageChunk,
  type Entity,
  type TopicLink,
  type RetrievalSignal,
} from "./types.js";

const STATE_FILENAME = "state.json";
const LONG_TERM_FILENAME = "longterm.md";
const LONG_TERM_TYPED_FILENAME = "longterm-typed.md";
const L1_ARCHIVE_DIR = "l1_archive";
const L2_DIR = "l2";
const L3_DIR = "l3";
const MSG_DIR = "msg";

/**
 * On-disk layout under `<root>/`:
 *
 *   state.json                          engine-wide cursors
 *   l1_archive/<chunk-id>.jsonl         raw transcript spillover (replayable)
 *   l2/<YYYY-MM-DD>/<chunk-id>.md       JSON-frontmatter + body summary
 *   l3/<epoch-id>.md                    JSON-frontmatter + digest body
 *
 * One Storage instance scopes to one root. All writes are atomic
 * (write-temp + rename) and serialized through an in-memory mutex.
 */
export class Storage {
  readonly root: string;
  private readonly mutex = new AsyncMutex();

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Create a Storage rooted at `<workspaceDir>/.openclaw/l3/`. Falls back to
   * a per-process temp dir when no workspaceDir is available so engines can
   * still operate in test environments without a workspace.
   */
  static fromWorkspace(workspaceDir: string | undefined): Storage {
    if (workspaceDir && workspaceDir.length > 0) {
      return new Storage(path.join(workspaceDir, ".openclaw", "l3"));
    }
    const fallback = path.join(os.tmpdir(), `openclaw-memory-l3-${randomUUID()}`);
    return new Storage(fallback);
  }

  async ensureLayout(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(path.join(this.root, L1_ARCHIVE_DIR), { recursive: true });
    await fs.mkdir(path.join(this.root, L2_DIR), { recursive: true });
    await fs.mkdir(path.join(this.root, L3_DIR), { recursive: true });
  }

  /** Read engine state, returning a fresh INITIAL_L3_STATE when absent. */
  async readState(): Promise<L3State> {
    const target = path.join(this.root, STATE_FILENAME);
    try {
      const raw = await fs.readFile(target, "utf8");
      const parsed = JSON.parse(raw) as Partial<L3State>;
      return { ...INITIAL_L3_STATE, ...parsed };
    } catch (err) {
      if (isNotFound(err)) {
        return { ...INITIAL_L3_STATE };
      }
      throw err;
    }
  }

  async writeState(state: L3State): Promise<void> {
    await this.mutex.run(async () => {
      const target = path.join(this.root, STATE_FILENAME);
      await atomicWriteFile(target, `${JSON.stringify(state, null, 2)}\n`);
    });
  }

  /** Append one JSONL record to the L1 archive for `chunkId`. */
  async appendL1Archive(chunkId: string, entry: unknown): Promise<void> {
    await this.mutex.run(async () => {
      const target = path.join(this.root, L1_ARCHIVE_DIR, `${chunkId}.jsonl`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.appendFile(target, `${JSON.stringify(entry)}\n`, "utf8");
    });
  }

  async writeL2Chunk(frontmatter: L2ChunkFrontmatter, body: string): Promise<string> {
    return await this.mutex.run(async () => {
      const datePartition = formatDatePartition(frontmatter.createdAt);
      const target = path.join(this.root, L2_DIR, datePartition, `${frontmatter.id}.md`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWriteFile(target, formatFrontmatterDocument(frontmatter, body));
      return target;
    });
  }

  async readL2Chunk(
    chunkId: string,
    createdAt: number,
  ): Promise<FrontmatterDocument<L2ChunkFrontmatter> | null> {
    const datePartition = formatDatePartition(createdAt);
    const target = path.join(this.root, L2_DIR, datePartition, `${chunkId}.md`);
    return await readFrontmatterDocument<L2ChunkFrontmatter>(target);
  }

  async readL2ChunkAtPath(
    filePath: string,
  ): Promise<FrontmatterDocument<L2ChunkFrontmatter> | null> {
    return await readFrontmatterDocument<L2ChunkFrontmatter>(filePath);
  }

  /** List every persisted L2 chunk path, sorted chronologically by partition. */
  async listL2ChunkPaths(): Promise<string[]> {
    const root = path.join(this.root, L2_DIR);
    if (!existsSync(root)) {
      return [];
    }
    const partitions = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const out: string[] = [];
    for (const partition of partitions) {
      const partitionDir = path.join(root, partition);
      const files = (await fs.readdir(partitionDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort();
      for (const file of files) {
        out.push(path.join(partitionDir, file));
      }
    }
    return out;
  }

  async writeL3Epoch(frontmatter: L3EpochFrontmatter, body: string): Promise<string> {
    return await this.mutex.run(async () => {
      const target = path.join(this.root, L3_DIR, `${frontmatter.id}.md`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWriteFile(target, formatFrontmatterDocument(frontmatter, body));
      return target;
    });
  }

  async readL3Epoch(epochId: string): Promise<FrontmatterDocument<L3EpochFrontmatter> | null> {
    const target = path.join(this.root, L3_DIR, `${epochId}.md`);
    return await readFrontmatterDocument<L3EpochFrontmatter>(target);
  }

  async listL3EpochPaths(): Promise<string[]> {
    const root = path.join(this.root, L3_DIR);
    if (!existsSync(root)) {
      return [];
    }
    const files = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    return files.map((file) => path.join(root, file));
  }

  async readL3EpochAtPath(
    filePath: string,
  ): Promise<FrontmatterDocument<L3EpochFrontmatter> | null> {
    return await readFrontmatterDocument<L3EpochFrontmatter>(filePath);
  }

  /**
   * Read the long-term tier file. Returns a fresh INITIAL_LONG_TERM_FRONTMATTER
   * (no facts) when the file is absent, so callers can treat the tier as
   * always-readable.
   */
  async readLongTerm(): Promise<LongTermFrontmatter> {
    const target = path.join(this.root, LONG_TERM_FILENAME);
    const doc = await readFrontmatterDocument<LongTermFrontmatter>(target);
    if (doc === null) {
      return { ...INITIAL_LONG_TERM_FRONTMATTER };
    }
    return doc.frontmatter;
  }

  /**
   * Atomically rewrite `<root>/longterm.md`. The body is a stable, ordered
   * markdown listing of the active facts for human inspection — frontmatter
   * remains the source of truth.
   */
  async writeLongTerm(frontmatter: LongTermFrontmatter, body: string): Promise<string> {
    return await this.mutex.run(async () => {
      const target = path.join(this.root, LONG_TERM_FILENAME);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWriteFile(target, formatFrontmatterDocument(frontmatter, body));
      return target;
    });
  }

  /**
   * Read the long-term typed-fact tier. Returns a fresh
   * INITIAL_LONG_TERM_TYPED_FRONTMATTER when the file is absent.
   */
  async readLongTermTyped(): Promise<LongTermTypedFrontmatter> {
    const target = path.join(this.root, LONG_TERM_TYPED_FILENAME);
    const doc = await readFrontmatterDocument<LongTermTypedFrontmatter>(target);
    if (doc === null) {
      return { ...INITIAL_LONG_TERM_TYPED_FRONTMATTER };
    }
    return doc.frontmatter;
  }

  /**
   * Atomically rewrite `<root>/longterm-typed.md` — the canonical
   * current-value-per-slot view across all L2 chunks' typed facts.
   */
  async writeLongTermTyped(frontmatter: LongTermTypedFrontmatter, body: string): Promise<string> {
    return await this.mutex.run(async () => {
      const target = path.join(this.root, LONG_TERM_TYPED_FILENAME);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWriteFile(target, formatFrontmatterDocument(frontmatter, body));
      return target;
    });
  }

  // -----------------------------------------------------------------
  // Message-level embedding chunks
  // -----------------------------------------------------------------

  /** Write message-level chunks for a given L2 chunk. */
  async writeMessageChunks(chunks: ReadonlyArray<MessageChunk>): Promise<void> {
    if (chunks.length === 0) return;
    await this.mutex.run(async () => {
      const chunkDir = path.join(this.root, MSG_DIR, chunks[0].chunkId);
      await fs.mkdir(chunkDir, { recursive: true });
      const data = chunks.map((c) => ({
        id: c.id,
        seq: c.seq,
        startMsgIndex: c.startMsgIndex,
        endMsgIndex: c.endMsgIndex,
        text: c.text,
        embedding: c.embedding,
        createdAt: c.createdAt,
        chunkId: c.chunkId,
      }));
      const target = path.join(chunkDir, "chunks.json");
      await atomicWriteFile(target, `${JSON.stringify(data, null, 2)}\n`);
    });
  }

  /** Read message-level chunks for a given L2 chunk ID. */
  async readMessageChunks(chunkId: string): Promise<MessageChunk[]> {
    const target = path.join(this.root, MSG_DIR, chunkId, "chunks.json");
    try {
      const raw = await fs.readFile(target, "utf8");
      return JSON.parse(raw) as MessageChunk[];
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  /** List all chunk IDs that have message-level index data. */
  async listMessageChunkIds(): Promise<string[]> {
    const root = path.join(this.root, MSG_DIR);
    if (!existsSync(root)) return [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  // -----------------------------------------------------------------
  // Entity index
  // -----------------------------------------------------------------

  /** Write the entity index (full replacement). */
  async writeEntityIndex(entities: ReadonlyArray<Entity>): Promise<void> {
    await this.mutex.run(async () => {
      const target = path.join(this.root, "entities.json");
      await atomicWriteFile(target, `${JSON.stringify(entities, null, 2)}\n`);
    });
  }

  /** Read the entity index. Returns empty array if not yet created. */
  async readEntityIndex(): Promise<Entity[]> {
    const target = path.join(this.root, "entities.json");
    try {
      const raw = await fs.readFile(target, "utf8");
      return JSON.parse(raw) as Entity[];
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  // -----------------------------------------------------------------
  // Topic links (cross-session graph)
  // -----------------------------------------------------------------

  /** Append topic links to the link graph (dedup by source+target pair). */
  async appendTopicLinks(links: ReadonlyArray<TopicLink>): Promise<void> {
    if (links.length === 0) return;
    await this.mutex.run(async () => {
      const target = path.join(this.root, "topic-links.json");
      const existing = await this.readTopicLinks();
      const keySet = new Set(existing.map((l) => `${l.sourceChunkId}::${l.targetChunkId}`));
      const newLinks = links.filter((l) => !keySet.has(`${l.sourceChunkId}::${l.targetChunkId}`));
      if (newLinks.length === 0) return;
      existing.push(...newLinks);
      await atomicWriteFile(target, `${JSON.stringify(existing, null, 2)}\n`);
    });
  }

  /** Read all topic links. */
  async readTopicLinks(): Promise<TopicLink[]> {
    const target = path.join(this.root, "topic-links.json");
    try {
      const raw = await fs.readFile(target, "utf8");
      return JSON.parse(raw) as TopicLink[];
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  // -----------------------------------------------------------------
  // Retrieval signals (dynamic importance)
  // -----------------------------------------------------------------

  /** Write retrieval signals (full replacement). */
  async writeRetrievalSignals(signals: ReadonlyArray<RetrievalSignal>): Promise<void> {
    await this.mutex.run(async () => {
      const target = path.join(this.root, "retrieval-signals.json");
      await atomicWriteFile(target, `${JSON.stringify(signals, null, 2)}\n`);
    });
  }

  /** Read retrieval signals. */
  async readRetrievalSignals(): Promise<RetrievalSignal[]> {
    const target = path.join(this.root, "retrieval-signals.json");
    try {
      const raw = await fs.readFile(target, "utf8");
      return JSON.parse(raw) as RetrievalSignal[];
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  // -----------------------------------------------------------------
  // Hebbian edge map
  // -----------------------------------------------------------------

  /** Read the Hebbian co-occurrence edge map from `edges.json`. */
  async readEdgeMap(): Promise<unknown[]> {
    const target = path.join(this.root, "edges.json");
    try {
      const raw = await fs.readFile(target, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  /** Write the Hebbian co-occurrence edge map to `edges.json`. */
  async writeEdgeMap(edges: unknown[]): Promise<void> {
    await this.mutex.run(async () => {
      const target = path.join(this.root, "edges.json");
      await atomicWriteFile(target, `${JSON.stringify(edges, null, 2)}\n`);
    });
  }
}

async function atomicWriteFile(target: string, contents: string): Promise<void> {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, contents, "utf8");
  await fs.rename(tmp, target);
}

function formatDatePartition(unixMs: number): string {
  const d = new Date(unixMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatFrontmatterDocument(frontmatter: unknown, body: string): string {
  const trimmedBody = body.trimEnd();
  return `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${trimmedBody}\n`;
}

async function readFrontmatterDocument<TFrontmatter>(
  target: string,
): Promise<FrontmatterDocument<TFrontmatter> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
  const opener = raw.indexOf("---\n");
  if (opener !== 0) {
    throw new Error(`Malformed frontmatter document at ${target}: missing opening fence`);
  }
  const closeAt = raw.indexOf("\n---\n", opener + 4);
  if (closeAt < 0) {
    throw new Error(`Malformed frontmatter document at ${target}: missing closing fence`);
  }
  const frontJson = raw.slice(opener + 4, closeAt);
  const body = raw.slice(closeAt + 5);
  const frontmatter = JSON.parse(frontJson) as TFrontmatter;
  return { frontmatter, body };
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "ENOENT",
  );
}

class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.chain;
    this.chain = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
