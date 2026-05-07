/**
 * Persistent state owned by the engine. Single source of truth for cross-run
 * resumption: chunk counters, last epoch boundary, buffered token count.
 */
export type L3State = {
  version: 1;
  agentId: string | null;
  bufferTokenCount: number;
  l2ChunkIndex: number;
  lastEpochAt: number;
  lastChunkId: string | null;
};

export const INITIAL_L3_STATE: L3State = {
  version: 1,
  agentId: null,
  bufferTokenCount: 0,
  l2ChunkIndex: 0,
  lastEpochAt: 0,
  lastChunkId: null,
};

/**
 * A single distilled fact extracted from a chunk of conversation. Importance
 * and dedupKey are used by retrieval scoring and within-chunk dedup.
 */
export type L2Fact = {
  id: string;
  text: string;
  importance: number;
  createdAt: number;
  dedupKey: string;
};

/**
 * JSON frontmatter persisted on L2 chunk markdown files. The body of the
 * markdown holds a human-readable summary; the structured data lives here.
 */
export type L2ChunkFrontmatter = {
  id: string;
  agentId: string | null;
  startTurnIndex: number;
  endTurnIndex: number;
  createdAt: number;
  facts: L2Fact[];
  dedupKeys: string[];
};

/**
 * A roll-up digest covering N consecutive L2 chunks. Used by retrieval as a
 * soft prior boost for queries that match the digest text.
 */
export type L3EpochFrontmatter = {
  id: string;
  agentId: string | null;
  startChunkId: string;
  endChunkId: string;
  createdAt: number;
  representativeFacts: L2Fact[];
};

export type FrontmatterDocument<TFrontmatter> = {
  frontmatter: TFrontmatter;
  body: string;
};
