/**
 * Lexical keyword search over the raw L1 archive (`l1_archive/*.jsonl`) — the
 * append-only replay of every compacted conversation message. This is the
 * fallback tier below L3: when promoted facts are thin or a detail was never
 * promoted, the verbatim transcript is still searchable. Read-only, no LLM
 * calls, no index maintenance (iterative scan — the archive is bounded by
 * compaction batching, one file per chunk).
 *
 * Ranking is session-aware rank fusion: each matching message gets a
 * message-level BM25-ish keyword score, its chunk (≈ session slice) gets the
 * sum of matching message scores, and the final score fuses both — a message
 * whose surrounding chunk also matches the query outranks an isolated hit of
 * equal keyword strength, mirroring how context confirms relevance.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { Storage } from "./storage.js";

const L1_ARCHIVE_DIR = "l1_archive";
const MATCH_TEXT_MAX_CHARS = 300;
/** Share of the fused score contributed by the message-level term score. */
const MESSAGE_WEIGHT = 0.7;
/** Share contributed by the (normalised) session-aggregate score. */
const SESSION_WEIGHT = 0.3;

/** Small English stopword list — keeps queries from matching on filler. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "for",
  "on",
  "with",
  "that",
  "this",
  "it",
  "at",
  "by",
  "from",
  "as",
  "i",
  "you",
  "we",
  "my",
  "your",
  "our",
  "me",
  "do",
  "does",
  "did",
  "so",
  "if",
  "but",
  "not",
  "can",
  "will",
]);

export type ArchiveMatch = {
  chunkId: string;
  /** Session id when known (message record or the chunk's typed-fact lineage). */
  sessionId?: string;
  role?: string;
  /** Message timestamp (ms) when the archived record carried one. */
  timestamp?: number;
  /** Chunk creation time (ms) — ordering fallback for timestamp-less records. */
  createdAt?: number;
  /** Fused final score (message + session terms). */
  score: number;
  messageScore: number;
  /** Sum of matching message scores in the same chunk. */
  sessionScore: number;
  /** Clipped verbatim message text. */
  text: string;
};

export type ArchiveSearchResult = {
  generatedAt: number;
  query: string;
  scanned: { chunks: number; messages: number };
  matchedChunks: number;
  since?: number;
  until?: number;
  sessionId?: string;
  matches: ArchiveMatch[];
};

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter(
    (t) => t.length >= 2 && !STOPWORDS.has(t),
  );
}

/** Extract plain text from an archived message record (string or parts array). */
function messageText(msg: unknown): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && "text" in p ? String((p as { text: string }).text) : "",
      )
      .join("");
  }
  return "";
}

function clip(text: string): string {
  return text.length > MATCH_TEXT_MAX_CHARS ? `${text.slice(0, MATCH_TEXT_MAX_CHARS)}…` : text;
}

/** Parse a `since`/`until` bound: epoch ms number or ISO-8601 string. */
export function parseTimeBound(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n) && value.trim() !== "") return n;
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

type ArchivedMessage = {
  chunkId: string;
  role?: string;
  sessionId?: string;
  timestamp?: number;
  text: string;
  /** Resolved ordering time: message timestamp, else chunk createdAt. */
  at: number;
};

/**
 * Iteratively search the L1 archive for `query`. All params are read-only:
 * the archive files and the L2 chunk DB (for session/date lineage) are only
 * ever read.
 */
export async function searchL1Archive(params: {
  storage: Storage;
  query: string;
  since?: number | string;
  until?: number | string;
  sessionId?: string;
  limit?: number;
  now?: number;
}): Promise<ArchiveSearchResult> {
  const now = params.now ?? Date.now();
  const limit = params.limit ?? 20;
  const since = parseTimeBound(params.since);
  const until = parseTimeBound(params.until);
  const queryTerms = [...new Set(tokenize(params.query))];

  const archiveDir = path.join(params.storage.root, L1_ARCHIVE_DIR);
  const files = (await fsp.readdir(archiveDir).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".jsonl"),
  );

  // Chunk lineage (createdAt + sessionIds from typed facts) is only needed
  // when filters demand it — read lazily from the L2 DB, cached per chunk.
  const lineageCache = new Map<string, { createdAt?: number; sessionIds: Set<string> } | null>();
  const lineageFor = async (
    chunkId: string,
  ): Promise<{ createdAt?: number; sessionIds: Set<string> } | null> => {
    if (lineageCache.has(chunkId)) return lineageCache.get(chunkId) ?? null;
    let entry: { createdAt?: number; sessionIds: Set<string> } | null = null;
    try {
      const doc = await params.storage.readL2ChunkAtPath(chunkId);
      if (doc) {
        entry = {
          createdAt: doc.frontmatter.createdAt,
          sessionIds: new Set(
            (doc.frontmatter.typedFacts ?? [])
              .map((t) => t.sessionId)
              .filter((s): s is string => Boolean(s)),
          ),
        };
      }
    } catch {
      entry = null; // missing chunk row — archive predates the DB or pruned
    }
    lineageCache.set(chunkId, entry);
    return entry;
  };

  const messages: ArchivedMessage[] = [];
  for (const file of files) {
    const chunkId = file.slice(0, -".jsonl".length);
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(archiveDir, file), "utf8");
    } catch {
      continue; // raced with pruning — skip
    }
    // Chunk lineage (createdAt + session ids) is only needed when temporal or
    // session filters are active; lineageFor() reads each chunk once (cached).
    const needLineage =
      params.sessionId !== undefined || since !== undefined || until !== undefined;
    const lineage = needLineage ? await lineageFor(chunkId) : null;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // malformed line — append-only archive may have partial tail
      }
      const record = msg as { role?: unknown; sessionId?: unknown; timestamp?: unknown };
      const role = typeof record.role === "string" ? record.role : undefined;
      const msgSessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
      const ts = typeof record.timestamp === "number" ? record.timestamp : undefined;
      const at = ts ?? lineage?.createdAt ?? now;
      if (since !== undefined && at < since) continue;
      if (until !== undefined && at > until) continue;
      if (
        params.sessionId !== undefined &&
        msgSessionId !== params.sessionId &&
        !(lineage?.sessionIds.has(params.sessionId) ?? false)
      ) {
        continue;
      }
      messages.push({
        chunkId,
        role,
        sessionId: msgSessionId,
        timestamp: ts,
        text: messageText(msg),
        at,
      });
    }
  }

  const totalMessages = messages.length;
  if (queryTerms.length === 0) {
    return {
      generatedAt: now,
      query: params.query,
      scanned: { chunks: files.length, messages: totalMessages },
      matchedChunks: 0,
      since,
      until,
      sessionId: params.sessionId,
      matches: [],
    };
  }

  // Document frequency per term, then a BM25-flavoured message score:
  // tf saturates via 1+ln(tf); rare terms weigh more via idf.
  const df = new Map<string, number>();
  const tokenCache = new Map<number, string[]>();
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    const tokens = tokenize(m.text);
    tokenCache.set(i, tokens);
    for (const term of queryTerms) {
      if (tokens.includes(term)) df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const idf = (term: string): number => Math.log(1 + totalMessages / (1 + (df.get(term) ?? 0)));

  const messageScores = new Map<number, number>();
  const chunkScores = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) {
    const tokens = tokenCache.get(i) ?? [];
    let score = 0;
    for (const term of queryTerms) {
      const tf = tokens.filter((t) => t === term).length;
      if (tf > 0) score += (1 + Math.log(tf)) * idf(term);
    }
    if (score > 0) {
      messageScores.set(i, score);
      const m = messages[i]!;
      chunkScores.set(m.chunkId, (chunkScores.get(m.chunkId) ?? 0) + score);
    }
  }

  const maxChunkScore = Math.max(...chunkScores.values(), 0);
  const maxMessageScore = Math.max(...messageScores.values(), 0);
  const matches: ArchiveMatch[] = [];
  for (const [i, messageScore] of messageScores) {
    const m = messages[i]!;
    const sessionScore = chunkScores.get(m.chunkId) ?? 0;
    // Both terms normalised to [0,1]: message keyword strength and the share
    // of the query's session-level evidence this chunk carries.
    const fused =
      MESSAGE_WEIGHT * (maxMessageScore > 0 ? messageScore / maxMessageScore : 0) +
      SESSION_WEIGHT * (maxChunkScore > 0 ? sessionScore / maxChunkScore : 0);
    matches.push({
      chunkId: m.chunkId,
      sessionId: m.sessionId,
      role: m.role,
      timestamp: m.timestamp,
      createdAt: undefined,
      score: Math.round(fused * 1e4) / 1e4,
      messageScore: Math.round(messageScore * 1e4) / 1e4,
      sessionScore: Math.round(sessionScore * 1e4) / 1e4,
      text: clip(m.text),
    });
  }
  matches.sort((a, b) => b.score - a.score || b.sessionScore - a.sessionScore);

  // Enrich top matches with chunk createdAt (cheap: ≤ limit lineage reads).
  for (const match of matches.slice(0, limit)) {
    const lineage = lineageCache.get(match.chunkId);
    if (lineage === undefined) {
      const l = await lineageFor(match.chunkId);
      match.createdAt = l?.createdAt;
      match.sessionId = match.sessionId ?? [...(l?.sessionIds ?? [])][0];
    } else {
      match.createdAt = lineage?.createdAt;
      match.sessionId = match.sessionId ?? [...(lineage?.sessionIds ?? [])][0];
    }
  }

  return {
    generatedAt: now,
    query: params.query,
    scanned: { chunks: files.length, messages: totalMessages },
    matchedChunks: chunkScores.size,
    since,
    until,
    sessionId: params.sessionId,
    matches: matches.slice(0, limit),
  };
}
