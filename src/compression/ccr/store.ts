/**
 * CCR Store — SQLite-backed reversible cache for compressed content.
 *
 * When the compression pipeline compresses a tool result, the original content
 * is stored here with a SHA-256 hash key. The compressed output gets a marker
 * like `[200 items → 15. Retrieve: hash=abc123]` so the model can request
 * the original data via the `ccr_retrieve` tool.
 *
 * Uses `node:sqlite` (built-in Node.js SQLite module) — zero npm dependencies.
 * Synchronous API mirrors the existing OpenClaw SQLite patterns.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import type { CCREntry } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ccr_cache (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL,
  original_chars INTEGER NOT NULL,
  compressed_chars INTEGER NOT NULL,
  message_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ccr_created ON ccr_cache(created_at);
CREATE INDEX IF NOT EXISTS idx_ccr_accessed ON ccr_cache(last_accessed_at);
`;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class CCRStore {
  private db: import("node:sqlite").DatabaseSync;
  private maxEntries: number;
  private ttlSeconds: number;
  private closed = false;

  constructor(dbPath: string, maxEntries: number, ttlSeconds: number) {
    // Ensure parent directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    const sqlite = requireNodeSqlite();
    this.db = new sqlite.DatabaseSync(dbPath);
    this.maxEntries = maxEntries;
    this.ttlSeconds = ttlSeconds;

    // Initialize schema
    this.db.exec(SCHEMA_SQL);
    // WAL mode for concurrent reads
    this.db.exec("PRAGMA journal_mode = WAL;");
  }

  /**
   * Store original content, return its SHA-256 hash key.
   * If content already exists (same hash), update last_accessed_at.
   */
  store(content: string, metadata: Omit<CCREntry, "hash" | "originalContent">): string {
    if (this.closed) throw new Error("CCRStore is closed");

    const hash = sha256(content);
    const now = Date.now();

    // Upsert: insert or update access time if already present
    const insert = this.db.prepare(`
      INSERT INTO ccr_cache (hash, content, content_type, original_chars, compressed_chars, message_index, created_at, last_accessed_at, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(hash) DO UPDATE SET
        last_accessed_at = excluded.last_accessed_at,
        access_count = access_count + 1
    `);
    insert.run(
      hash,
      content,
      metadata.contentType,
      metadata.originalChars,
      metadata.compressedChars,
      metadata.messageIndex,
      now,
      now,
    );

    return hash;
  }

  /**
   * Retrieve original content by hash. Returns null if not found.
   */
  retrieve(hash: string): string | null {
    if (this.closed) return null;

    const stmt = this.db.prepare("SELECT content FROM ccr_cache WHERE hash = ?");
    const row = stmt.get(hash) as { content: string } | undefined;
    if (!row) return null;

    // Update access metadata
    const update = this.db.prepare(
      "UPDATE ccr_cache SET last_accessed_at = ?, access_count = access_count + 1 WHERE hash = ?",
    );
    update.run(Date.now(), hash);

    return row.content;
  }

  /**
   * Get metadata for a cached entry (without the content itself).
   */
  getMeta(hash: string): CCREntry | null {
    if (this.closed) return null;

    const stmt = this.db.prepare(
      "SELECT hash, content_type, original_chars, compressed_chars, message_index, created_at FROM ccr_cache WHERE hash = ?",
    );
    const row = stmt.get(hash) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      hash: row.hash as string,
      originalContent: "", // Not loaded for meta queries
      messageIndex: row.message_index as number,
      compressedAt: row.created_at as number,
      contentType: row.content_type as string,
      originalChars: row.original_chars as number,
      compressedChars: row.compressed_chars as number,
    };
  }

  /**
   * Search within stored content using simple keyword matching.
   * Returns matching content snippets (up to maxResults).
   */
  search(hash: string, query: string, maxResults: number = 5): string[] {
    if (this.closed) return [];

    const content = this.retrieve(hash);
    if (!content) return [];

    // Simple line-based keyword search
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const lines = content.split("\n");
    const matches: string[] = [];

    for (const line of lines) {
      if (matches.length >= maxResults) break;
      const lower = line.toLowerCase();
      if (keywords.every((kw) => lower.includes(kw))) {
        matches.push(line);
      }
    }

    return matches;
  }

  /**
   * Evict expired entries. Returns number of entries evicted.
   */
  evict(): number {
    if (this.closed) return 0;

    const cutoff = Date.now() - this.ttlSeconds * 1000;

    // Delete expired entries
    const del = this.db.prepare("DELETE FROM ccr_cache WHERE created_at < ?");
    const result = del.run(cutoff);

    // Enforce max entries (LRU eviction)
    const count = this.getCount();
    if (count > this.maxEntries) {
      const excess = count - this.maxEntries;
      const evictStmt = this.db.prepare(
        "DELETE FROM ccr_cache WHERE hash IN (SELECT hash FROM ccr_cache ORDER BY last_accessed_at ASC LIMIT ?)",
      );
      evictStmt.run(excess);
      return result.changes + excess;
    }

    return result.changes;
  }

  /**
   * Get count of cached entries.
   */
  getCount(): number {
    if (this.closed) return 0;
    const stmt = this.db.prepare("SELECT COUNT(*) as cnt FROM ccr_cache");
    const row = stmt.get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Check if the store is closed. */
  get isClosed(): boolean {
    return this.closed;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
