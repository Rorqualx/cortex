/**
 * Raw-archive lexical search over `l1_archive/*.jsonl` (2026-08-23 QW1,
 * from ReFind finding 3).
 *
 * Agent-driven lexical search over raw turns rivals structured memory: it
 * hedges against consolidation loss by searching what was actually said,
 * verbatim, before any L2/L3 summarization touched it. The archive is
 * append-only by design; this module is the read path — stream turns,
 * score with the existing BM25 primitives from scoring.ts, and return
 * matches with session/temporal context so the agent can iterate keywords.
 *
 * Cost controls: turns scanned are capped (most-recent chunks first) and
 * per-file parse results are cached keyed on mtime so repeated queries in
 * one process don't re-parse unchanged files.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bm25Score, buildCorpusStats, tokenize, type CorpusStats } from "./scoring.js";
import { Storage } from "./storage.js";

const ARCHIVE_DIR = "l1_archive";
/** Hard cap on turns examined per query — protects large archives. */
export const ARCHIVE_SEARCH_MAX_TURNS = 20000;
/** Display clip for hit text. */
const HIT_TEXT_MAX_CHARS = 240;
/** Per-file parse-cache bound (files, not turns). */
const FILE_CACHE_MAX = 64;

/** One parsed replay turn. */
type ParsedTurn = {
  chunkId: string;
  line: number;
  role: string;
  text: string;
  timestamp: number | null;
};

type CachedFile = {
  mtimeMs: number;
  turns: ParsedTurn[];
};

const fileCache = new Map<string, CachedFile>();

/** Extract searchable text + role + timestamp from a raw archived message. */
function parseTurn(chunkId: string, line: number, raw: string): ParsedTurn | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  const candidate = message as {
    role?: unknown;
    content?: unknown;
    timestamp?: unknown;
    toolName?: unknown;
  };
  const role = typeof candidate?.role === "string" ? candidate.role : "unknown";
  let text = "";
  if (typeof candidate?.content === "string") {
    text = candidate.content;
  } else if (Array.isArray(candidate?.content)) {
    const parts: string[] = [];
    for (const block of candidate.content) {
      const b = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
      if (b?.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      } else if (b?.type === "toolCall" && typeof b.name === "string") {
        // Tool calls carry heavy search signal ("which turn ran read on X").
        parts.push(`${b.name} ${JSON.stringify(b.arguments ?? {})}`);
      }
    }
    text = parts.join(" ");
  }
  if (role === "toolResult" && typeof candidate?.toolName === "string" && text.length === 0) {
    text = `[toolResult ${candidate.toolName}]`;
  }
  if (text.trim().length === 0) {
    return null;
  }
  const timestamp = typeof candidate?.timestamp === "number" ? candidate.timestamp : null;
  return { chunkId, line, role, text, timestamp };
}

/** Parse one archive file, using the mtime-keyed cache when fresh. */
async function loadFile(archiveDir: string, fileName: string): Promise<ParsedTurn[]> {
  const filePath = path.join(archiveDir, fileName);
  const chunkId = fileName.replace(/\.jsonl$/, "");
  const { mtimeMs } = await fs.stat(filePath);
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    // Refresh LRU position.
    fileCache.delete(filePath);
    fileCache.set(filePath, cached);
    return cached.turns;
  }
  const raw = await fs.readFile(filePath, "utf8");
  const turns: ParsedTurn[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) continue;
    const turn = parseTurn(chunkId, i + 1, line);
    if (turn) turns.push(turn);
  }
  if (fileCache.size >= FILE_CACHE_MAX) {
    const oldest = fileCache.keys().next().value;
    if (oldest !== undefined) fileCache.delete(oldest);
  }
  fileCache.set(filePath, { mtimeMs, turns });
  return turns;
}

export type ArchiveSearchHit = {
  chunkId: string;
  sessionId: string | null;
  role: string;
  text: string;
  score: number;
  line: number;
  timestamp: number | null;
};

export type ArchiveSearchResult = {
  generatedAt: number;
  query: string;
  filesScanned: number;
  turnsScanned: number;
  turnsCapped: boolean;
  hits: ArchiveSearchHit[];
};

/**
 * Lexically search the raw L1 archive. Files are visited newest-first (by
 * mtime) so the turn cap favors recent history; temporal filters fall back
 * from message timestamps to the chunk-session sidecar's createdAt, and
 * turns with neither are conservatively excluded when a temporal filter is
 * active. Session filters only apply to chunks recorded in the sidecar
 * (chunks compacted before it existed carry no session attribution).
 */
export async function searchArchive(params: {
  storage: Storage;
  query: string;
  sessionHint?: string;
  before?: number;
  after?: number;
  skipSessionIds?: string[];
  limit?: number;
  maxTurns?: number;
  now?: number;
}): Promise<ArchiveSearchResult> {
  const now = params.now ?? Date.now();
  const limit = params.limit ?? 10;
  const maxTurns = params.maxTurns ?? ARCHIVE_SEARCH_MAX_TURNS;
  const archiveDir = path.join(params.storage.root, ARCHIVE_DIR);

  let fileNames: string[] = [];
  try {
    fileNames = (await fs.readdir(archiveDir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return {
      generatedAt: now,
      query: params.query,
      filesScanned: 0,
      turnsScanned: 0,
      turnsCapped: false,
      hits: [],
    };
  }
  // Newest files first — the cap then protects oldest history.
  const withMtime = await Promise.all(
    fileNames.map(async (name) => ({
      name,
      mtimeMs: (await fs.stat(path.join(archiveDir, name))).mtimeMs,
    })),
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const chunkSessions = await params.storage.readChunkSessions();
  const skip = new Set(params.skipSessionIds ?? []);

  const candidates: ParsedTurn[] = [];
  let filesScanned = 0;
  let turnsScanned = 0;
  let turnsCapped = false;
  for (const file of withMtime) {
    const chunkId = file.name.replace(/\.jsonl$/, "");
    const meta = chunkSessions.get(chunkId);
    if (params.sessionHint && !(meta?.sessionId ?? "").includes(params.sessionHint)) {
      // Without sidecar attribution the chunk can't match a session hint.
      continue;
    }
    if (meta && skip.has(meta.sessionId)) {
      continue;
    }
    const turns = await loadFile(archiveDir, file.name);
    filesScanned += 1;
    let cappedThisFile = false;
    for (const turn of turns) {
      if (turnsScanned >= maxTurns) {
        cappedThisFile = true;
        break;
      }
      turnsScanned += 1;
      const effectiveTs = turn.timestamp ?? meta?.createdAt ?? null;
      if (params.after !== undefined || params.before !== undefined) {
        if (effectiveTs === null) continue;
        if (params.after !== undefined && effectiveTs < params.after) continue;
        if (params.before !== undefined && effectiveTs > params.before) continue;
      }
      candidates.push(turn);
    }
    if (cappedThisFile) {
      turnsCapped = true;
      break;
    }
  }

  const corpusStats: CorpusStats = buildCorpusStats(candidates.map((t) => t.text));
  const queryTokens = tokenize(params.query);
  const scored = candidates
    .map((turn) => ({
      turn,
      score: bm25Score(queryTokens, turn.text, corpusStats),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    generatedAt: now,
    query: params.query,
    filesScanned,
    turnsScanned,
    turnsCapped,
    hits: scored.map(({ turn, score }) => ({
      chunkId: turn.chunkId,
      sessionId: chunkSessions.get(turn.chunkId)?.sessionId ?? null,
      role: turn.role,
      text:
        turn.text.length > HIT_TEXT_MAX_CHARS
          ? `${turn.text.slice(0, HIT_TEXT_MAX_CHARS)}…`
          : turn.text,
      score: Math.round(score * 1e4) / 1e4,
      line: turn.line,
      timestamp: turn.timestamp ?? chunkSessions.get(turn.chunkId)?.createdAt ?? null,
    })),
  };
}
