/**
 * Lexical keyword search over the L1 archive (`l1_archive/*.jsonl`) — the
 * append-only raw-transcript tier that survives even when nothing was promoted
 * to L2/L3. This is the memory_insights fallback surface ("use when L3 facts
 * are thin"): no embeddings, no LLM, pure iterative keyword retrieval with
 * session-aware rank fusion (ReFind-inspired):
 *
 *   1. Chunk selection pass — match query terms against every archive chunk;
 *      chunks with zero term coverage are dropped (iterative narrowing).
 *   2. Message scoring pass — score each message inside surviving chunks by
 *      term coverage + density.
 *   3. Rank fusion — each chunk acts as a coarse "session slice" proxy; the
 *      fused score blends message rank with the chunk's aggregate coverage so
 *      hits from sessions that discuss the topic more broadly outrank isolated
 *      keyword coincidences.
 *
 * Read-only; never mutates the store.
 */
import { Storage } from "./storage.js";
import type { FrontmatterDocument, L2ChunkFrontmatter } from "./types.js";

type ChunkDoc = FrontmatterDocument<L2ChunkFrontmatter> | null;

const HIT_TEXT_MAX_CHARS = 300;
const MIN_TERM_LENGTH = 2;

export type ArchiveSearchHit = {
  chunkId: string;
  /** Session that produced the chunk, resolved from L2 fact provenance when available. */
  sessionId?: string;
  /** 0-based record index within the chunk's JSONL file. */
  index: number;
  role: string;
  /** Clipped verbatim transcript text of the matched record. */
  text: string;
  timestamp?: number;
  /** Fused rank score (0–1-ish; higher = better). */
  score: number;
  matchedTerms: string[];
};

export type ArchiveSearchResult = {
  generatedAt: number;
  query: string;
  terms: string[];
  chunksScanned: number;
  chunksMatched: number;
  messagesScanned: number;
  hits: ArchiveSearchHit[];
};

/** Lowercase alphanumeric terms, deduped, length-capped noise dropped. */
export function tokenizeQuery(query: string): string[] {
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TERM_LENGTH && !terms.includes(raw)) {
      terms.push(raw);
    }
  }
  return terms;
}

/** Extract displayable text from an archive record (string or text-part content). */
function extractRecordText(record: Record<string, unknown>): string {
  const content = record.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block !== null && typeof block === "object") {
      const b = block as { text?: unknown };
      if (typeof b.text === "string") {
        parts.push(b.text);
      }
    }
  }
  return parts.join("\n");
}

/** Occurrences of `needle` in `haystack`, both pre-lowercased. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function clip(text: string): string {
  return text.length > HIT_TEXT_MAX_CHARS ? `${text.slice(0, HIT_TEXT_MAX_CHARS)}…` : text;
}

/** Session ids + createdAt for a chunk, resolved from its L2 frontmatter. */
function chunkMeta(doc: ChunkDoc): {
  sessionIds: Set<string>;
  createdAt: number | null;
} {
  if (!doc) {
    return { sessionIds: new Set(), createdAt: null };
  }
  const sessionIds = new Set<string>();
  for (const fact of [...doc.frontmatter.facts, ...(doc.frontmatter.typedFacts ?? [])]) {
    if (typeof fact.sessionId === "string" && fact.sessionId.length > 0) {
      sessionIds.add(fact.sessionId);
    }
  }
  return { sessionIds, createdAt: doc.frontmatter.createdAt };
}

/**
 * Search the raw L1 archive for `query`. Temporal bounds (`since`/`until`,
 * epoch ms, inclusive) use the record's own timestamp when present and fall
 * back to the chunk's L2 `createdAt`; records with neither are only matched
 * when no bounds are given. `sessionId` restricts to chunks whose L2 facts
 * cite that session.
 */
export async function searchMemoryArchive(params: {
  storage: Storage;
  query: string;
  since?: number;
  until?: number;
  sessionId?: string;
  limit?: number;
  now?: number;
}): Promise<ArchiveSearchResult> {
  const now = params.now ?? Date.now();
  const limit = params.limit ?? 20;
  const terms = tokenizeQuery(params.query);
  const empty: ArchiveSearchResult = {
    generatedAt: now,
    query: params.query,
    terms,
    chunksScanned: 0,
    chunksMatched: 0,
    messagesScanned: 0,
    hits: [],
  };
  if (terms.length === 0) {
    return empty;
  }

  const chunkIds = await params.storage.listL1ArchiveChunkIds();
  const needChunkDoc =
    params.since !== undefined || params.until !== undefined || params.sessionId !== undefined;

  let messagesScanned = 0;
  let chunksMatched = 0;
  const fused: Array<{ hit: ArchiveSearchHit }> = [];

  for (const chunkId of chunkIds) {
    const records = await params.storage.readL1ArchiveChunk(chunkId);
    messagesScanned += records.length;

    // Resolve the L2 doc only when filters demand it (session/temporal) or,
    // later, for hit metadata — never for a pure keyword sweep.
    const doc = needChunkDoc ? await params.storage.readL2Chunk(chunkId, 0) : null;
    const meta = chunkMeta(doc);

    if (params.sessionId !== undefined && !meta.sessionIds.has(params.sessionId)) {
      continue;
    }

    const perTermOccurrences = new Map<string, number>(terms.map((t) => [t, 0]));
    const scored: Array<{
      index: number;
      role: string;
      text: string;
      timestamp?: number;
      occurrences: number;
      matched: string[];
      messageScore: number;
    }> = [];

    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (record === undefined) {
        continue;
      }
      const recordTs = record.timestamp;
      const timestamp = typeof recordTs === "number" ? recordTs : (meta.createdAt ?? undefined);
      if (
        (params.since !== undefined || params.until !== undefined) &&
        timestamp !== undefined &&
        ((params.since !== undefined && timestamp < params.since) ||
          (params.until !== undefined && timestamp > params.until))
      ) {
        continue;
      }
      const text = extractRecordText(record);
      if (text.length === 0) {
        continue;
      }
      const lowered = text.toLowerCase();
      let occurrences = 0;
      const matched: string[] = [];
      for (const term of terms) {
        const n = countOccurrences(lowered, term);
        occurrences += n;
        if (n > 0) {
          matched.push(term);
          perTermOccurrences.set(term, (perTermOccurrences.get(term) ?? 0) + n);
        }
      }
      if (matched.length === 0) {
        continue;
      }
      // Term coverage dominates; raw density saturates so one chatty message
      // cannot out-rank a message that covers the whole query.
      const coverage = matched.length / terms.length;
      const density = Math.min(occurrences, terms.length * 3) / (terms.length * 3);
      scored.push({
        index: i,
        role: typeof record.role === "string" ? record.role : "unknown",
        text,
        timestamp,
        occurrences,
        matched,
        messageScore: 0.7 * coverage + 0.3 * density,
      });
    }

    if (scored.length === 0) {
      continue;
    }
    chunksMatched += 1;

    // Resolve the L2 doc now (if not already) so hits carry sessionId metadata.
    const hitMeta =
      meta.sessionIds.size > 0 || meta.createdAt !== null
        ? meta
        : chunkMeta(needChunkDoc ? doc : await params.storage.readL2Chunk(chunkId, 0));

    // Chunk (session-slice) coverage: which fraction of the query did this
    // chunk's transcript discuss at all — the fusion prior.
    const chunkCoverage =
      [...perTermOccurrences.values()].filter((n) => n > 0).length / terms.length;

    for (const m of scored) {
      fused.push({
        hit: {
          chunkId,
          sessionId: params.sessionId ?? [...hitMeta.sessionIds][0],
          index: m.index,
          role: m.role,
          text: clip(m.text),
          timestamp: m.timestamp,
          score: Math.round((0.75 * m.messageScore + 0.25 * chunkCoverage) * 1e4) / 1e4,
          matchedTerms: m.matched,
        },
      });
    }
  }

  fused.sort(
    (a, b) => b.hit.score - a.hit.score || (b.hit.timestamp ?? 0) - (a.hit.timestamp ?? 0),
  );

  return {
    generatedAt: now,
    query: params.query,
    terms,
    chunksScanned: chunkIds.length,
    chunksMatched,
    messagesScanned,
    hits: fused.slice(0, limit).map((f) => f.hit),
  };
}
