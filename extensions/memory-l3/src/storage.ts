import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  ensureDir,
  parseEmbedding,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  type FrontmatterDocument,
  INITIAL_INSIGHT_FRONTMATTER,
  INITIAL_L3_STATE,
  INITIAL_LONG_TERM_FRONTMATTER,
  INITIAL_LONG_TERM_TYPED_FRONTMATTER,
  type InsightFrontmatter,
  type L2ChunkFrontmatter,
  type L3EpochFrontmatter,
  type L3State,
  type LongTermFrontmatter,
  type LongTermTypedFrontmatter,
  type MessageChunk,
  type Entity,
  type TopicLink,
  type RetrievalSignal,
  type L3MetricEntry,
  type L3CompactionEventEntry,
} from "./types.js";

const DB_FILENAME = "l3.sqlite";
const L1_ARCHIVE_DIR = "l1_archive";
const L2_DIR = "l2";
const L3_DIR = "l3";
const LONG_TERM_FILENAME = "longterm.md";
const LONG_TERM_TYPED_FILENAME = "longterm-typed.md";

const KV_STATE = "state";
const KV_LONG_TERM = "longterm";
const KV_LONG_TERM_TYPED = "longterm_typed";
const KV_INSIGHTS = "insights";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS l3_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS l3_l2_chunks (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  frontmatter TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS l3_l2_chunks_created ON l3_l2_chunks (created_at, id);
CREATE TABLE IF NOT EXISTS l3_epochs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  frontmatter TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS l3_epochs_created ON l3_epochs (created_at, id);
CREATE TABLE IF NOT EXISTS l3_message_chunks (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  start_msg_index INTEGER NOT NULL,
  end_msg_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS l3_message_chunks_chunk ON l3_message_chunks (chunk_id, seq);
CREATE TABLE IF NOT EXISTS l3_entities (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS l3_topic_links (
  source_chunk_id TEXT NOT NULL,
  target_chunk_id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (source_chunk_id, target_chunk_id)
);
CREATE TABLE IF NOT EXISTS l3_retrieval_signals (
  fact_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS l3_edges (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS l3_hype_queries (
  fact_id TEXT NOT NULL,
  query_seq INTEGER NOT NULL,
  query_text TEXT NOT NULL,
  embedding TEXT NOT NULL,
  PRIMARY KEY (fact_id, query_seq)
);
CREATE INDEX IF NOT EXISTS l3_hype_queries_fact ON l3_hype_queries (fact_id);
CREATE TABLE IF NOT EXISTS l3_metrics (
  session_id TEXT NOT NULL,
  consolidations INTEGER NOT NULL DEFAULT 0,
  promotions INTEGER NOT NULL DEFAULT 0,
  demotions INTEGER NOT NULL DEFAULT 0,
  merges INTEGER NOT NULL DEFAULT 0,
  tokens_spent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS l3_metrics_created ON l3_metrics (created_at, session_id);
CREATE TABLE IF NOT EXISTS l3_compaction_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_cursor INTEGER NOT NULL,
  tokens_before INTEGER NOT NULL DEFAULT 0,
  messages_before INTEGER NOT NULL DEFAULT 0,
  tool_calls_before INTEGER NOT NULL DEFAULT 0,
  messages_after INTEGER,
  tool_calls_after INTEGER,
  reacquisition_spike INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS l3_compaction_events_session ON l3_compaction_events (session_id, created_at);
`;

/**
 * SQLite-backed storage for one L3 root.
 *
 * Canonical state lives in a dedicated per-root database at `<root>/l3.sqlite`
 * (WAL). A dedicated DB — rather than the shared per-agent `openclaw-agent.sqlite`
 * — is justified by L3's distinct schema, embedding volume, and workspace-scoped
 * lifecycle (the same reasoning behind the cross-agent shared store; see the
 * decision record in `AGENTS.md`). `new Storage(root)` and `fromWorkspace` keep
 * their original signatures so every caller and test is unchanged.
 *
 * Human-inspectable tiers (`l2/*.md`, `l3/*.md`, `longterm.md`,
 * `longterm-typed.md`) are written through as regenerated EXPORTS after each
 * commit so operators keep their grep/diff workflow; reads always come from the
 * DB, so the exports can never drift from the source of truth. The raw L1
 * archive (`l1_archive/*.jsonl`) stays a file — it is an append-only replay
 * artifact, not index state.
 */
export class Storage {
  readonly root: string;
  private db: DatabaseSync | null = null;

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

  /** Open (once) and return the per-root WAL database, ensuring the L3 schema. */
  private database(): DatabaseSync {
    if (this.db) {
      return this.db;
    }
    ensureDir(this.root);
    const dbPath = path.join(this.root, DB_FILENAME);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath);
    try {
      configureMemorySqliteWalMaintenance(db, { busyTimeoutMs: 5000, databasePath: dbPath });
      db.exec(SCHEMA_SQL);
    } catch (err) {
      try {
        closeMemorySqliteWalMaintenance(db);
        db.close();
      } catch {
        // Preserve the original open error; cleanup failure is secondary.
      }
      throw err;
    }
    this.db = db;
    return db;
  }

  /** Close the database handle. Safe to call when never opened. */
  close(): void {
    if (!this.db) {
      return;
    }
    closeMemorySqliteWalMaintenance(this.db);
    this.db.close();
    this.db = null;
  }

  async ensureLayout(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(path.join(this.root, L1_ARCHIVE_DIR), { recursive: true });
    // Open the DB up front so a fresh root is immediately usable.
    this.database();
  }

  // -----------------------------------------------------------------
  // Engine state
  // -----------------------------------------------------------------

  /** Read engine state, returning a fresh INITIAL_L3_STATE when absent. */
  async readState(): Promise<L3State> {
    const raw = this.readKv(KV_STATE);
    if (raw === null) {
      return { ...INITIAL_L3_STATE };
    }
    return { ...INITIAL_L3_STATE, ...(JSON.parse(raw) as Partial<L3State>) };
  }

  async writeState(state: L3State): Promise<void> {
    this.writeKv(KV_STATE, JSON.stringify(state));
  }

  // -----------------------------------------------------------------
  // L1 archive — append-only replay artifact, kept as a JSONL file
  // -----------------------------------------------------------------

  /** Append one JSONL record to the L1 archive for `chunkId`. */
  async appendL1Archive(chunkId: string, entry: unknown): Promise<void> {
    const target = path.join(this.root, L1_ARCHIVE_DIR, `${chunkId}.jsonl`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, `${JSON.stringify(entry)}\n`, "utf8");
  }

  // -----------------------------------------------------------------
  // L2 chunks (summary tier) — DB canonical, markdown export
  // -----------------------------------------------------------------

  async writeL2Chunk(frontmatter: L2ChunkFrontmatter, body: string): Promise<string> {
    const db = this.database();
    runSqliteImmediateTransactionSync(db, () => {
      db.prepare(
        "INSERT OR REPLACE INTO l3_l2_chunks (id, created_at, frontmatter, body) VALUES (?, ?, ?, ?)",
      ).run(frontmatter.id, frontmatter.createdAt, JSON.stringify(frontmatter), markdownBody(body));
    });
    const exportPath = this.l2ChunkPath(frontmatter.id, frontmatter.createdAt);
    await this.exportFrontmatterDocument(exportPath, frontmatter, body);
    return exportPath;
  }

  async readL2Chunk(
    chunkId: string,
    _createdAt: number,
  ): Promise<FrontmatterDocument<L2ChunkFrontmatter> | null> {
    return this.readChunkRow<L2ChunkFrontmatter>("l3_l2_chunks", chunkId);
  }

  /**
   * Read an L2 chunk. The arg is a token from `listL2ChunkPaths` — an export
   * path whose basename is the chunk id (see class doc); reads come from the DB.
   */
  async readL2ChunkAtPath(
    chunkToken: string,
  ): Promise<FrontmatterDocument<L2ChunkFrontmatter> | null> {
    return this.readChunkRow<L2ChunkFrontmatter>("l3_l2_chunks", chunkIdFromToken(chunkToken));
  }

  /**
   * List every L2 chunk as an export-path token, chronological (oldest first).
   * Tokens are `<root>/l2/<YYYY-MM-DD>/<id>.md` so callers that derive the date
   * partition or round-trip through `readL2ChunkAtPath` keep working.
   */
  async listL2ChunkPaths(): Promise<string[]> {
    const rows = this.database()
      .prepare("SELECT id, created_at FROM l3_l2_chunks ORDER BY created_at, id")
      .all() as Array<{ id: string; created_at: number }>;
    return rows.map((row) => this.l2ChunkPath(row.id, row.created_at));
  }

  /** Delete one L2 chunk (DB row + best-effort export file). Used for pruning. */
  async deleteL2Chunk(chunkToken: string): Promise<void> {
    const id = chunkIdFromToken(chunkToken);
    const db = this.database();
    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("DELETE FROM l3_l2_chunks WHERE id = ?").run(id);
    });
    if (chunkToken.includes(path.sep) || chunkToken.endsWith(".md")) {
      await fs.rm(chunkToken, { force: true });
    }
  }

  // -----------------------------------------------------------------
  // L3 epochs (roll-up tier) — DB canonical, markdown export
  // -----------------------------------------------------------------

  async writeL3Epoch(frontmatter: L3EpochFrontmatter, body: string): Promise<string> {
    const db = this.database();
    runSqliteImmediateTransactionSync(db, () => {
      db.prepare(
        "INSERT OR REPLACE INTO l3_epochs (id, created_at, frontmatter, body) VALUES (?, ?, ?, ?)",
      ).run(frontmatter.id, frontmatter.createdAt, JSON.stringify(frontmatter), markdownBody(body));
    });
    const exportPath = path.join(this.root, L3_DIR, `${frontmatter.id}.md`);
    await this.exportFrontmatterDocument(exportPath, frontmatter, body);
    return exportPath;
  }

  async readL3Epoch(epochId: string): Promise<FrontmatterDocument<L3EpochFrontmatter> | null> {
    return this.readChunkRow<L3EpochFrontmatter>("l3_epochs", epochId);
  }

  /** List every L3 epoch as an export-path token `<root>/l3/<id>.md`, oldest first. */
  async listL3EpochPaths(): Promise<string[]> {
    const rows = this.database()
      .prepare("SELECT id FROM l3_epochs ORDER BY created_at, id")
      .all() as Array<{ id: string }>;
    return rows.map((row) => path.join(this.root, L3_DIR, `${row.id}.md`));
  }

  /** Read an L3 epoch. The arg is a token from `listL3EpochPaths` (see class doc). */
  async readL3EpochAtPath(
    epochToken: string,
  ): Promise<FrontmatterDocument<L3EpochFrontmatter> | null> {
    return this.readChunkRow<L3EpochFrontmatter>("l3_epochs", chunkIdFromToken(epochToken));
  }

  // -----------------------------------------------------------------
  // Long-term tiers (prose + typed) — DB canonical, markdown export
  // -----------------------------------------------------------------

  /**
   * Read the long-term tier. Returns a fresh INITIAL_LONG_TERM_FRONTMATTER (no
   * facts) when absent, so callers can treat the tier as always-readable.
   */
  async readLongTerm(): Promise<LongTermFrontmatter> {
    const raw = this.readKv(KV_LONG_TERM);
    if (raw === null) {
      return { ...INITIAL_LONG_TERM_FRONTMATTER };
    }
    return JSON.parse(raw) as LongTermFrontmatter;
  }

  /**
   * Persist the long-term tier, then regenerate `<root>/longterm.md` (a stable,
   * ordered, human-inspectable listing). The DB frontmatter is the source of
   * truth; the markdown is a derived export.
   */
  async writeLongTerm(frontmatter: LongTermFrontmatter, body: string): Promise<string> {
    this.writeKv(KV_LONG_TERM, JSON.stringify(frontmatter));
    const exportPath = path.join(this.root, LONG_TERM_FILENAME);
    await this.exportFrontmatterDocument(exportPath, frontmatter, body);
    return exportPath;
  }

  /** Read the long-term typed-fact tier. Returns INITIAL when absent. */
  async readLongTermTyped(): Promise<LongTermTypedFrontmatter> {
    const raw = this.readKv(KV_LONG_TERM_TYPED);
    if (raw === null) {
      return { ...INITIAL_LONG_TERM_TYPED_FRONTMATTER };
    }
    return JSON.parse(raw) as LongTermTypedFrontmatter;
  }

  /** Persist the typed long-term tier, then regenerate `<root>/longterm-typed.md`. */
  async writeLongTermTyped(frontmatter: LongTermTypedFrontmatter, body: string): Promise<string> {
    this.writeKv(KV_LONG_TERM_TYPED, JSON.stringify(frontmatter));
    const exportPath = path.join(this.root, LONG_TERM_TYPED_FILENAME);
    await this.exportFrontmatterDocument(exportPath, frontmatter, body);
    return exportPath;
  }

  /** Read the G1 reflection insight tier. Returns INITIAL when absent. */
  async readInsights(): Promise<InsightFrontmatter> {
    const raw = this.readKv(KV_INSIGHTS);
    if (raw === null) {
      return { ...INITIAL_INSIGHT_FRONTMATTER };
    }
    return JSON.parse(raw) as InsightFrontmatter;
  }

  /** Persist the insight tier. Canonical state is the KV blob; no markdown
   * export (insights are synthesized, not an operator grep artifact). */
  async writeInsights(frontmatter: InsightFrontmatter): Promise<void> {
    this.writeKv(KV_INSIGHTS, JSON.stringify(frontmatter));
  }

  // -----------------------------------------------------------------
  // Message-level embedding chunks
  // -----------------------------------------------------------------

  /** Write message-level chunks for a given L2 chunk (replaces that chunk's rows). */
  async writeMessageChunks(chunks: ReadonlyArray<MessageChunk>): Promise<void> {
    const first = chunks[0];
    if (!first) {
      return;
    }
    const db = this.database();
    const parentChunkId = first.chunkId;
    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("DELETE FROM l3_message_chunks WHERE chunk_id = ?").run(parentChunkId);
      const insert = db.prepare(
        "INSERT OR REPLACE INTO l3_message_chunks " +
          "(id, chunk_id, seq, start_msg_index, end_msg_index, text, embedding, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const c of chunks) {
        insert.run(
          c.id,
          c.chunkId,
          c.seq,
          c.startMsgIndex,
          c.endMsgIndex,
          c.text,
          JSON.stringify(c.embedding),
          c.createdAt,
        );
      }
    });
  }

  /** Read message-level chunks for a given L2 chunk ID, ordered by sequence. */
  async readMessageChunks(chunkId: string): Promise<MessageChunk[]> {
    const rows = this.database()
      .prepare(
        "SELECT id, chunk_id, seq, start_msg_index, end_msg_index, text, embedding, created_at " +
          "FROM l3_message_chunks WHERE chunk_id = ? ORDER BY seq",
      )
      .all(chunkId) as Array<{
      id: string;
      chunk_id: string;
      seq: number;
      start_msg_index: number;
      end_msg_index: number;
      text: string;
      embedding: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      seq: row.seq,
      startMsgIndex: row.start_msg_index,
      endMsgIndex: row.end_msg_index,
      text: row.text,
      embedding: parseEmbedding(row.embedding),
      createdAt: row.created_at,
      chunkId: row.chunk_id,
    }));
  }

  /** List all chunk IDs that have message-level index data. */
  async listMessageChunkIds(): Promise<string[]> {
    const rows = this.database()
      .prepare("SELECT DISTINCT chunk_id FROM l3_message_chunks")
      .all() as Array<{ chunk_id: string }>;
    return rows.map((row) => row.chunk_id);
  }

  // -----------------------------------------------------------------
  // Entity index (full replacement)
  // -----------------------------------------------------------------

  async writeEntityIndex(entities: ReadonlyArray<Entity>): Promise<void> {
    const db = this.database();
    runSqliteImmediateTransactionSync(db, () => {
      db.exec("DELETE FROM l3_entities");
      const insert = db.prepare("INSERT OR REPLACE INTO l3_entities (id, data) VALUES (?, ?)");
      for (const entity of entities) {
        insert.run(entity.id, JSON.stringify(entity));
      }
    });
  }

  async readEntityIndex(): Promise<Entity[]> {
    return this.readJsonRows<Entity>("SELECT data FROM l3_entities");
  }

  // -----------------------------------------------------------------
  // Topic links (cross-session graph) — dedup by (source, target) PK
  // -----------------------------------------------------------------

  async appendTopicLinks(links: ReadonlyArray<TopicLink>): Promise<void> {
    if (links.length === 0) {
      return;
    }
    const db = this.database();
    runSqliteImmediateTransactionSync(db, () => {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO l3_topic_links (source_chunk_id, target_chunk_id, data) VALUES (?, ?, ?)",
      );
      for (const link of links) {
        insert.run(link.sourceChunkId, link.targetChunkId, JSON.stringify(link));
      }
    });
  }

  async readTopicLinks(): Promise<TopicLink[]> {
    return this.readJsonRows<TopicLink>("SELECT data FROM l3_topic_links");
  }

  // -----------------------------------------------------------------
  // Retrieval signals (dynamic importance) — full replacement
  // -----------------------------------------------------------------

  async writeRetrievalSignals(signals: ReadonlyArray<RetrievalSignal>): Promise<void> {
    const db = this.database();
    runSqliteImmediateTransactionSync(db, () => {
      db.exec("DELETE FROM l3_retrieval_signals");
      const insert = db.prepare(
        "INSERT OR REPLACE INTO l3_retrieval_signals (fact_id, data) VALUES (?, ?)",
      );
      for (const signal of signals) {
        insert.run(signal.factId, JSON.stringify(signal));
      }
    });
  }

  async readRetrievalSignals(): Promise<RetrievalSignal[]> {
    return this.readJsonRows<RetrievalSignal>("SELECT data FROM l3_retrieval_signals");
  }

  // -----------------------------------------------------------------
  // Hebbian edge map (opaque array, full replacement)
  // -----------------------------------------------------------------

  async readEdgeMap(): Promise<unknown[]> {
    return this.readJsonRows<unknown>("SELECT data FROM l3_edges ORDER BY row_id");
  }

  async writeEdgeMap(edges: unknown[]): Promise<void> {
    const db = this.database();
    runSqliteImmediateTransactionSync(db, () => {
      db.exec("DELETE FROM l3_edges");
      const insert = db.prepare("INSERT INTO l3_edges (data) VALUES (?)");
      for (const edge of edges) {
        insert.run(JSON.stringify(edge));
      }
    });
  }

  // -----------------------------------------------------------------
  // HyPE query embeddings (Hypothetical Prompt Embeddings)
  // -----------------------------------------------------------------
  // Pre-generated hypothetical user queries (2-3 per fact) that would
  // retrieve each typed fact. At retrieval time, the query matches against
  // both fact embeddings and HyPE query embeddings, improving recall for
  // phrasings that differ from how the fact was originally stored.

  /** Write HyPE queries for a specific fact (replaces any existing). */
  async writeHypeQueries(
    factId: string,
    queries: ReadonlyArray<{ text: string; embedding?: number[] }>,
  ): Promise<void> {
    const db = this.database();
    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("DELETE FROM l3_hype_queries WHERE fact_id = ?").run(factId);
      const insert = db.prepare(
        "INSERT OR REPLACE INTO l3_hype_queries (fact_id, query_seq, query_text, embedding) VALUES (?, ?, ?, ?)",
      );
      queries.forEach((q, i) => {
        insert.run(factId, i, q.text, JSON.stringify(q.embedding ?? []));
      });
    });
  }

  /** Read HyPE queries for a specific fact. */
  async readHypeQueries(
    factId: string,
  ): Promise<Array<{ querySeq: number; queryText: string; embedding: number[] }>> {
    const rows = this.database()
      .prepare(
        "SELECT query_seq, query_text, embedding FROM l3_hype_queries WHERE fact_id = ? ORDER BY query_seq",
      )
      .all(factId) as Array<{ query_seq: number; query_text: string; embedding: string }>;
    return rows.map((row) => ({
      querySeq: row.query_seq,
      queryText: row.query_text,
      embedding: parseEmbedding(row.embedding),
    }));
  }

  /** Read all HyPE queries (for retrieval-time scan). */
  async readAllHypeQueries(): Promise<
    Array<{ factId: string; querySeq: number; queryText: string; embedding: number[] }>
  > {
    const rows = this.database()
      .prepare(
        "SELECT fact_id, query_seq, query_text, embedding FROM l3_hype_queries ORDER BY fact_id, query_seq",
      )
      .all() as Array<{
      fact_id: string;
      query_seq: number;
      query_text: string;
      embedding: string;
    }>;
    return rows.map((row) => ({
      factId: row.fact_id,
      querySeq: row.query_seq,
      queryText: row.query_text,
      embedding: parseEmbedding(row.embedding),
    }));
  }

  // -----------------------------------------------------------------
  // Cost-attribution metrics (arXiv:2608.11879) — append-only
  // -----------------------------------------------------------------
  // One row per completed engine cycle so per-session memory cost is
  // attributable. Evidence base for the Q3-2026-deferred decisions:
  // construction admission control (trigger p95 > 5s) and sqlite-vec ANN
  // (trigger ~10k chunks).

  /** Append one cost-attribution metric row for a completed engine cycle. */
  async recordMetric(entry: L3MetricEntry, now: number = Date.now()): Promise<void> {
    this.database()
      .prepare(
        "INSERT INTO l3_metrics (session_id, consolidations, promotions, demotions, merges, tokens_spent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.sessionId,
        Math.max(0, Math.trunc(entry.consolidations)),
        Math.max(0, Math.trunc(entry.promotions)),
        Math.max(0, Math.trunc(entry.demotions)),
        Math.max(0, Math.trunc(entry.merges)),
        Math.max(0, Math.trunc(entry.tokensSpent)),
        now,
      );
  }

  /** Read metric rows, optionally restricted to those at/after `sinceMs`. */
  async readMetrics(sinceMs?: number): Promise<Array<L3MetricEntry & { createdAt: number }>> {
    const rows = (
      sinceMs === undefined
        ? this.database()
            .prepare(
              "SELECT session_id, consolidations, promotions, demotions, merges, tokens_spent, created_at FROM l3_metrics ORDER BY created_at",
            )
            .all()
        : this.database()
            .prepare(
              "SELECT session_id, consolidations, promotions, demotions, merges, tokens_spent, created_at FROM l3_metrics WHERE created_at >= ? ORDER BY created_at",
            )
            .all(sinceMs)
    ) as Array<{
      session_id: string;
      consolidations: number;
      promotions: number;
      demotions: number;
      merges: number;
      tokens_spent: number;
      created_at: number;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      consolidations: row.consolidations,
      promotions: row.promotions,
      demotions: row.demotions,
      merges: row.merges,
      tokensSpent: row.tokens_spent,
      createdAt: row.created_at,
    }));
  }

  // -----------------------------------------------------------------
  // Reacquisition telemetry (ReFind finding 7, 2026-08-23) — one row per
  // after-turn compaction event; the after-window stats are back-filled at
  // the session's next event so before/after tool-call rates join on one row.
  // -----------------------------------------------------------------

  /** Append one compaction-event row (before-window stats only). */
  async recordCompactionEvent(
    entry: Omit<
      L3CompactionEventEntry,
      "messagesAfter" | "toolCallsAfter" | "reacquisitionSpike" | "createdAt"
    > & {
      createdAt?: number;
    },
  ): Promise<number> {
    const info = this.database()
      .prepare(
        "INSERT INTO l3_compaction_events (session_id, message_cursor, tokens_before, messages_before, tool_calls_before, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.sessionId,
        Math.max(0, Math.trunc(entry.messageCursor)),
        Math.max(0, Math.trunc(entry.tokensBefore)),
        Math.max(0, Math.trunc(entry.messagesBefore)),
        Math.max(0, Math.trunc(entry.toolCallsBefore)),
        entry.createdAt ?? Date.now(),
      );
    return Number(info.lastInsertRowid);
  }

  /**
   * Latest compaction event for a session whose after-window stats are still
   * open (null when none exists). Used to back-fill at the next event.
   */
  async readOpenCompactionEvent(sessionId: string): Promise<L3CompactionEventEntry | null> {
    const row = this.database()
      .prepare(
        "SELECT event_id, session_id, message_cursor, tokens_before, messages_before, tool_calls_before, messages_after, tool_calls_after, reacquisition_spike, created_at FROM l3_compaction_events WHERE session_id = ? AND tool_calls_after IS NULL ORDER BY event_id DESC LIMIT 1",
      )
      .get(sessionId) as
      | {
          event_id: number;
          session_id: string;
          message_cursor: number;
          tokens_before: number;
          messages_before: number;
          tool_calls_before: number;
          messages_after: number | null;
          tool_calls_after: number | null;
          reacquisition_spike: number | null;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      eventId: row.event_id,
      sessionId: row.session_id,
      messageCursor: row.message_cursor,
      tokensBefore: row.tokens_before,
      messagesBefore: row.messages_before,
      toolCallsBefore: row.tool_calls_before,
      messagesAfter: row.messages_after ?? undefined,
      toolCallsAfter: row.tool_calls_after ?? undefined,
      reacquisitionSpike:
        row.reacquisition_spike === null ? undefined : row.reacquisition_spike === 1,
      createdAt: row.created_at,
    };
  }

  /** Back-fill the after-window stats (and spike verdict) on an open event row. */
  async completeCompactionEvent(
    eventId: number,
    messagesAfter: number,
    toolCallsAfter: number,
    reacquisitionSpike: boolean,
  ): Promise<void> {
    this.database()
      .prepare(
        "UPDATE l3_compaction_events SET messages_after = ?, tool_calls_after = ?, reacquisition_spike = ? WHERE event_id = ?",
      )
      .run(
        Math.max(0, Math.trunc(messagesAfter)),
        Math.max(0, Math.trunc(toolCallsAfter)),
        reacquisitionSpike ? 1 : 0,
        eventId,
      );
  }

  /** Read compaction-event rows, optionally restricted to those at/after `sinceMs`. */
  async readCompactionEvents(sinceMs?: number): Promise<L3CompactionEventEntry[]> {
    const rows = (
      sinceMs === undefined
        ? this.database()
            .prepare(
              "SELECT event_id, session_id, message_cursor, tokens_before, messages_before, tool_calls_before, messages_after, tool_calls_after, reacquisition_spike, created_at FROM l3_compaction_events ORDER BY event_id",
            )
            .all()
        : this.database()
            .prepare(
              "SELECT event_id, session_id, message_cursor, tokens_before, messages_before, tool_calls_before, messages_after, tool_calls_after, reacquisition_spike, created_at FROM l3_compaction_events WHERE created_at >= ? ORDER BY event_id",
            )
            .all(sinceMs)
    ) as Array<{
      event_id: number;
      session_id: string;
      message_cursor: number;
      tokens_before: number;
      messages_before: number;
      tool_calls_before: number;
      messages_after: number | null;
      tool_calls_after: number | null;
      reacquisition_spike: number | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      sessionId: row.session_id,
      messageCursor: row.message_cursor,
      tokensBefore: row.tokens_before,
      messagesBefore: row.messages_before,
      toolCallsBefore: row.tool_calls_before,
      messagesAfter: row.messages_after ?? undefined,
      toolCallsAfter: row.tool_calls_after ?? undefined,
      reacquisitionSpike:
        row.reacquisition_spike === null ? undefined : row.reacquisition_spike === 1,
      createdAt: row.created_at,
    }));
  }
  // -----------------------------------------------------------------

  private readKv(key: string): string | null {
    const row = this.database().prepare("SELECT value FROM l3_kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private writeKv(key: string, value: string): void {
    const db = this.database();
    runSqliteImmediateTransactionSync(db, () => {
      db.prepare("INSERT OR REPLACE INTO l3_kv (key, value) VALUES (?, ?)").run(key, value);
    });
  }

  private async readChunkRow<TFrontmatter>(
    table: "l3_l2_chunks" | "l3_epochs",
    id: string,
  ): Promise<FrontmatterDocument<TFrontmatter> | null> {
    const row = this.database()
      .prepare(`SELECT frontmatter, body FROM ${table} WHERE id = ?`)
      .get(id) as { frontmatter: string; body: string } | undefined;
    if (!row) {
      return null;
    }
    return { frontmatter: JSON.parse(row.frontmatter) as TFrontmatter, body: row.body };
  }

  /** Export-path token for an L2 chunk, matching the on-disk markdown layout. */
  private l2ChunkPath(id: string, createdAt: number): string {
    return path.join(this.root, L2_DIR, formatDatePartition(createdAt), `${id}.md`);
  }

  private readJsonRows<T>(sql: string): T[] {
    const stmt: StatementSync = this.database().prepare(sql);
    const rows = stmt.all() as Array<{ data: string }>;
    const out: T[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.data) as T);
      } catch {
        // A single corrupt row must not take down the whole index read.
      }
    }
    return out;
  }

  /**
   * Write a regenerated `.md` export of a tier. Best-effort: an export failure
   * (e.g. read-only workspace) must not fail the canonical DB write that already
   * committed. Bytes match the previous on-disk format so operator grep/diff
   * workflows are preserved.
   */
  private async exportFrontmatterDocument(
    target: string,
    frontmatter: unknown,
    body: string,
  ): Promise<void> {
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWriteFile(target, formatFrontmatterDocument(frontmatter, body));
    } catch {
      // Export is derived from the DB; losing it is recoverable on next write.
    }
  }
}

async function atomicWriteFile(target: string, contents: string): Promise<void> {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, contents, "utf8");
  await fs.rename(tmp, target);
}

/**
 * Normalize a tier body to the exact bytes the prior markdown round-trip
 * produced (`<trimmed body>\n`), so DB readback matches the legacy file readback.
 */
function markdownBody(body: string): string {
  return `${body.trimEnd()}\n`;
}

/** Extract the chunk/epoch id from a list token (export path) or bare id. */
function chunkIdFromToken(token: string): string {
  return path.basename(token).replace(/\.md$/, "");
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
