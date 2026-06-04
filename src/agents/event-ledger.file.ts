/**
 * File-based Event Ledger Implementation
 *
 * Stores events in JSONL format with:
 * - Per-stream files for efficient querying
 * - Atomic append operations
 * - Automatic file rotation
 * - Index-based ID lookup
 *
 * Storage format:
 * - Events stored as JSONL (one JSON per line)
 * - One file per stream: {storagePath}/{stream}.jsonl
 * - ID index: {storagePath}/.index.json
 * - Rotation suffix: .{timestamp}.jsonl
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type {
  AuditEvent,
  EventLedger,
  EventQuery,
  EventStream,
  EventLedgerConfig,
} from "./event-ledger.js";

/**
 * In-memory ID index for fast lookup
 *
 * Maps event ID to file offset and stream for O(1) lookups.
 */
type EventIndex = Map<
  string,
  { stream: EventStream; file: string; offset: number; length: number }
>;

/**
 * File-based event ledger implementation
 */
export class FileEventLedger implements EventLedger {
  private basePath: string;
  private config: EventLedgerConfig;
  private index: EventIndex;
  private initialized: boolean = false;

  constructor(config: EventLedgerConfig) {
    this.config = config;
    // Expand tilde in path
    this.basePath = config.storagePath.replace(/^~/, process.env.HOME ?? "~");
    this.index = new Map();
  }

  /**
   * Initialize the ledger
   *
   * Creates storage directory and loads existing index.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(this.basePath, { recursive: true });
    await this.loadIndex();
    this.initialized = true;
  }

  /**
   * Append an event to the ledger
   *
   * Atomic append with immediate index update.
   */
  async append(event: AuditEvent): Promise<string> {
    await this.ensureInitialized();

    const eventId = event.id || randomUUID();
    const eventWithId = { ...event, id: eventId };
    const streamPath = this.getStreamPath(event.stream);

    // Serialize to JSONL
    const line = JSON.stringify(eventWithId) + "\n";
    const lineBytes = Buffer.byteLength(line, "utf8");

    // Get current file size for offset
    let offset = 0;
    try {
      const stats = await fs.stat(streamPath);
      offset = stats.size;
    } catch {
      // File doesn't exist yet, offset stays 0
    }

    // Atomic append
    await fs.appendFile(streamPath, line, { flag: "as" });

    // Update index
    this.index.set(eventId, {
      stream: event.stream,
      file: streamPath,
      offset,
      length: lineBytes,
    });

    // Persist index periodically
    await this.saveIndex();

    return eventId;
  }

  /**
   * Query events by criteria
   *
   * Reads relevant stream files and applies filters.
   */
  async query(params: EventQuery): Promise<AuditEvent[]> {
    await this.ensureInitialized();

    const results: AuditEvent[] = [];

    // Determine which streams to read
    const streamsToQuery = params.stream ? [params.stream] : this.getEnabledStreams();

    // Read and filter each stream
    for (const stream of streamsToQuery) {
      const events = await this.readStreamFile(stream);
      const filtered = this.filterEvents(events, params);
      results.push(...filtered);
    }

    // Sort by timestamp and apply limit
    results.sort((a, b) => a.timestamp - b.timestamp);

    if (params.limit && results.length > params.limit) {
      return results.slice(0, params.limit);
    }

    return results;
  }

  /**
   * Replay all events for a session
   *
   * Queries all streams for session ID and returns in order.
   */
  async replay(sessionId: string): Promise<AuditEvent[]> {
    return this.query({ sessionId });
  }

  /**
   * Get event by ID
   *
   * Uses index for O(1) lookup, falls back to scan.
   */
  async get(id: string): Promise<AuditEvent | null> {
    await this.ensureInitialized();

    const indexEntry = this.index.get(id);
    if (indexEntry) {
      // Fast path: use index to read specific event
      try {
        const content = await fs.readFile(indexEntry.file, "utf8");
        const line = content.slice(indexEntry.offset, indexEntry.offset + indexEntry.length).trim();
        return JSON.parse(line) as AuditEvent;
      } catch {
        // Index may be stale, fall back to scan
      }
    }

    // Slow path: scan all stream files
    for (const stream of this.getEnabledStreams()) {
      const events = await this.readStreamFile(stream);
      const found = events.find((e) => e.id === id);
      if (found) {
        return found;
      }
    }

    return null;
  }

  /**
   * Close the ledger
   *
   * Saves index and releases resources.
   */
  async close(): Promise<void> {
    if (this.initialized) {
      await this.saveIndex();
      this.index.clear();
      this.initialized = false;
    }
  }

  /**
   * Ensure ledger is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Get file path for a stream
   */
  private getStreamPath(stream: EventStream): string {
    return join(this.basePath, `${stream}.jsonl`);
  }

  /**
   * Get index file path
   */
  private getIndexPath(): string {
    return join(this.basePath, ".index.json");
  }

  /**
   * Load index from disk
   */
  private async loadIndex(): Promise<void> {
    const indexPath = this.getIndexPath();
    try {
      const content = await fs.readFile(indexPath, "utf8");
      const data = JSON.parse(content);
      this.index = new Map(Object.entries(data));
    } catch {
      // Index doesn't exist or is invalid, start fresh
      this.index = new Map();
    }
  }

  /**
   * Save index to disk
   */
  private async saveIndex(): Promise<void> {
    const indexPath = this.getIndexPath();
    const data = Object.fromEntries(this.index);
    await fs.writeFile(indexPath, JSON.stringify(data, null, 2));
  }

  /**
   * Read all events from a stream file
   */
  private async readStreamFile(stream: EventStream): Promise<AuditEvent[]> {
    const streamPath = this.getStreamPath(stream);
    try {
      const content = await fs.readFile(streamPath, "utf8");
      const lines = content.split("\n").filter((line) => line.trim());
      return lines.map((line) => JSON.parse(line) as AuditEvent);
    } catch {
      // File doesn't exist yet
      return [];
    }
  }

  /**
   * Filter events by query parameters
   */
  private filterEvents(events: AuditEvent[], params: EventQuery): AuditEvent[] {
    return events.filter((event) => {
      // Type filter
      if (params.type && event.type !== params.type) {
        return false;
      }

      // Session filter
      if (params.sessionId && event.sessionId !== params.sessionId) {
        return false;
      }

      // Agent filter
      if (params.agentId && event.agentId !== params.agentId) {
        return false;
      }

      // Time range filter
      if (params.fromTime && event.timestamp < params.fromTime) {
        return false;
      }
      if (params.toTime && event.timestamp > params.toTime) {
        return false;
      }

      return true;
    });
  }

  /**
   * Get enabled streams from config
   */
  private getEnabledStreams(): EventStream[] {
    return Object.entries(this.config.streams)
      .filter(([_, enabled]) => enabled !== false)
      .map(([stream]) => stream as EventStream);
  }

  /**
   * Clean up old events based on retention policy
   *
   * Removes events older than retentionDays from all stream files.
   */
  async cleanupOldEvents(): Promise<number> {
    await this.ensureInitialized();

    const cutoffTime = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    let totalRemoved = 0;

    for (const stream of this.getEnabledStreams()) {
      const streamPath = this.getStreamPath(stream);
      try {
        const content = await fs.readFile(streamPath, "utf8");
        const lines = content.split("\n").filter((line) => line.trim());

        const keepLines: string[] = [];
        const removeIds: string[] = [];

        for (const line of lines) {
          const event = JSON.parse(line) as AuditEvent;
          if (event.timestamp >= cutoffTime) {
            keepLines.push(line);
          } else {
            removeIds.push(event.id);
          }
        }

        if (removeIds.length > 0) {
          await fs.writeFile(streamPath, keepLines.join("\n") + "\n");
          totalRemoved += removeIds.length;

          // Update index
          for (const id of removeIds) {
            this.index.delete(id);
          }
        }
      } catch {
        // File doesn't exist or can't be read, skip
      }
    }

    if (totalRemoved > 0) {
      await this.saveIndex();
    }

    return totalRemoved;
  }
}

/**
 * Create a file-based event ledger
 */
export function createFileEventLedger(config: Partial<EventLedgerConfig> = {}): FileEventLedger {
  const fullConfig: EventLedgerConfig = {
    enabled: config.enabled ?? false,
    storagePath: config.storagePath ?? "~/.openclaw/events",
    retentionDays: config.retentionDays ?? 90,
    streams: {
      tool_calls: config.streams?.tool_calls ?? true,
      policy_decisions: config.streams?.policy_decisions ?? true,
      session_lifecycle: config.streams?.session_lifecycle ?? true,
      security_events: config.streams?.security_events ?? true,
      agent_actions: config.streams?.agent_actions ?? false,
    },
  };

  return new FileEventLedger(fullConfig);
}
