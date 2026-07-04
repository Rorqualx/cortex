import type { Storage } from "./storage.js";
import type { L2Fact, L3EpochFrontmatter, L3State } from "./types.js";

export const EPOCH_CHUNK_THRESHOLD = 4;
export const REPRESENTATIVE_FACT_COUNT = 8;

/**
 * Write an L3 epoch digest if the current chunk index lands on an epoch
 * boundary. Returns the new epoch id when one was written, otherwise null.
 *
 * The digest is algorithmic (no LLM): we collect every fact from the last
 * EPOCH_CHUNK_THRESHOLD L2 chunks, sort by importance descending (recency
 * breaks ties), and persist the top REPRESENTATIVE_FACT_COUNT facts as the
 * epoch's representative set. Retrieval (stage 8 polish) blends these with
 * a small ε weight so older-but-important facts still surface for queries
 * that match the epoch theme.
 * 
 * NOTE: Eviction policy analysis (2026-07-04):
 * Epoch-based consolidation avoids per-chunk eviction policies entirely. This is
 * appropriate for L2 tier which manages consolidation, not cache eviction. For
 * future retrieval buffer management at ANN milestone, use SOLAR Bayesian approach.
 */
export async function maybeWriteEpoch(params: {
  storage: Storage;
  state: L3State;
  now: number;
}): Promise<string | null> {
  const idx = params.state.l2ChunkIndex;
  if (idx === 0 || idx % EPOCH_CHUNK_THRESHOLD !== 0) {
    return null;
  }

  const paths = await params.storage.listL2ChunkPaths();
  const recentPaths = paths.slice(-EPOCH_CHUNK_THRESHOLD);
  if (recentPaths.length === 0) {
    return null;
  }

  const facts: L2Fact[] = [];
  let firstChunkId: string | undefined;
  let lastChunkId: string | undefined;

  for (const filePath of recentPaths) {
    const doc = await params.storage.readL2ChunkAtPath(filePath);
    if (!doc) {
      continue;
    }
    if (firstChunkId === undefined) {
      firstChunkId = doc.frontmatter.id;
    }
    lastChunkId = doc.frontmatter.id;
    for (const fact of doc.frontmatter.facts) {
      facts.push(fact);
    }
  }

  if (firstChunkId === undefined || lastChunkId === undefined) {
    return null;
  }

  facts.sort((a, b) => {
    if (b.importance !== a.importance) {
      return b.importance - a.importance;
    }
    return b.createdAt - a.createdAt;
  });
  const representative = facts.slice(0, REPRESENTATIVE_FACT_COUNT);

  const epochIdx = Math.floor(idx / EPOCH_CHUNK_THRESHOLD) - 1;
  const epochId = `epoch-${String(epochIdx).padStart(4, "0")}`;
  const frontmatter: L3EpochFrontmatter = {
    id: epochId,
    agentId: params.state.agentId,
    startChunkId: firstChunkId,
    endChunkId: lastChunkId,
    createdAt: params.now,
    representativeFacts: representative,
  };

  await params.storage.writeL3Epoch(
    frontmatter,
    formatEpochBody(representative, recentPaths.length),
  );
  params.state.lastEpochAt = params.now;
  return epochId;
}

function formatEpochBody(facts: ReadonlyArray<L2Fact>, chunkCount: number): string {
  const factSection =
    facts.length > 0
      ? `## Representative facts\n${facts.map((f) => `- [${f.importance.toFixed(2)}] ${f.text}`).join("\n")}`
      : "## Representative facts\n(none)";
  return `${factSection}\n\n## Coverage\nDigest of ${chunkCount} L2 chunk(s).`;
}
