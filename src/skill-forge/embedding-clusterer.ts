import type { TrajectoryEvent } from "../trajectory/types.js";
import {
  extractToolSequence,
  hashToolSequence,
  readCaptureEvents,
  type RepetitionCandidate,
} from "./detector.js";

export const DEFAULT_COSINE_THRESHOLD = 0.85;
export const DEFAULT_TOOL_SHAPE_OVERLAP_MIN = 0.5;
export const DEFAULT_SEED_TEXT_MAX_CHARS = 2000;

export type EmbedFn = (text: string) => Promise<number[]>;

export type EmbeddingClustererOptions = {
  embed: EmbedFn;
  cosineThreshold?: number;
  toolShapeOverlapMin?: number;
  seedTextMaxChars?: number;
};

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block) {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

export function extractCaptureSeedText(
  events: TrajectoryEvent[],
  maxChars: number = DEFAULT_SEED_TEXT_MAX_CHARS,
): string {
  const userTexts: string[] = [];
  for (const event of events) {
    if (event.type !== "user.message") {
      continue;
    }
    const message = event.data?.message;
    if (!message || typeof message !== "object") {
      continue;
    }
    const text = extractContentText((message as { content?: unknown }).content);
    if (text.length > 0) {
      userTexts.push(text);
    }
  }
  const toolSequence = extractToolSequence(events);
  const composed = [
    userTexts.length > 0 ? `User: ${userTexts.join("\n")}` : "",
    toolSequence.length > 0 ? `Tools: ${toolSequence.join(" -> ")}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return composed.length > maxChars ? composed.slice(0, maxChars) : composed;
}

export function toolShapeOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 1;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const value of setA) {
    if (setB.has(value)) {
      intersect += 1;
    }
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersect / union;
}

type EmbeddedCapture = {
  captureDir: string;
  toolSequence: string[];
  embedding: number[];
};

export function clusterByCosineAndToolShape(
  items: readonly EmbeddedCapture[],
  cosineThreshold: number,
  toolShapeMin: number,
): EmbeddedCapture[][] {
  const visited = new Set<number>();
  const clusters: EmbeddedCapture[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (visited.has(i)) {
      continue;
    }
    const cluster: EmbeddedCapture[] = [items[i]];
    visited.add(i);
    for (let j = i + 1; j < items.length; j += 1) {
      if (visited.has(j)) {
        continue;
      }
      const cos = cosineSimilarity(items[i].embedding, items[j].embedding);
      if (cos < cosineThreshold) {
        continue;
      }
      const overlap = toolShapeOverlap(items[i].toolSequence, items[j].toolSequence);
      if (overlap < toolShapeMin) {
        continue;
      }
      cluster.push(items[j]);
      visited.add(j);
    }
    clusters.push(cluster);
  }
  return clusters;
}

export type EmbeddingClusteringReport = {
  embeddedCaptures: number;
  skippedCaptures: Array<{ captureDir: string; reason: string }>;
  candidates: RepetitionCandidate[];
};

const REPETITION_THRESHOLD_FOR_EMBEDDING_LANE = 2;

function candidateIdForCluster(
  toolSequence: readonly string[],
  captureDirs: readonly string[],
): string {
  const hash = hashToolSequence([...toolSequence, ...captureDirs.toSorted()]);
  return `emb-${hash}`;
}

export async function detectEmbeddingRepetitionCandidates(params: {
  captureDirs: string[];
  options: EmbeddingClustererOptions;
}): Promise<EmbeddingClusteringReport> {
  const cosineThreshold = params.options.cosineThreshold ?? DEFAULT_COSINE_THRESHOLD;
  const toolShapeMin = params.options.toolShapeOverlapMin ?? DEFAULT_TOOL_SHAPE_OVERLAP_MIN;
  const seedTextMaxChars = params.options.seedTextMaxChars ?? DEFAULT_SEED_TEXT_MAX_CHARS;
  const embedded: EmbeddedCapture[] = [];
  const skipped: Array<{ captureDir: string; reason: string }> = [];
  for (const captureDir of params.captureDirs) {
    const events = await readCaptureEvents(captureDir);
    if (events.length === 0) {
      skipped.push({ captureDir, reason: "no events in capture" });
      continue;
    }
    const toolSequence = extractToolSequence(events);
    const seedText = extractCaptureSeedText(events, seedTextMaxChars);
    if (seedText.length === 0) {
      skipped.push({ captureDir, reason: "no seed text extracted" });
      continue;
    }
    let embedding: number[];
    try {
      embedding = await params.options.embed(seedText);
    } catch (error) {
      skipped.push({
        captureDir,
        reason: `embed call failed: ${error instanceof Error ? error.message : "unknown"}`,
      });
      continue;
    }
    if (!Array.isArray(embedding) || embedding.length === 0) {
      skipped.push({ captureDir, reason: "embed returned empty vector" });
      continue;
    }
    embedded.push({ captureDir, toolSequence, embedding });
  }

  const clusters = clusterByCosineAndToolShape(embedded, cosineThreshold, toolShapeMin);
  const candidates: RepetitionCandidate[] = [];
  for (const cluster of clusters) {
    if (cluster.length < REPETITION_THRESHOLD_FOR_EMBEDDING_LANE) {
      continue;
    }
    const toolSequence = cluster[0].toolSequence;
    const captureDirs = cluster.map((item) => item.captureDir);
    const candidateId = candidateIdForCluster(toolSequence, captureDirs);
    candidates.push({
      lane: "tool-shape",
      candidateId,
      toolShapeHash: hashToolSequence(toolSequence),
      toolSequence,
      captureDirs,
      occurrences: cluster.length,
    });
  }

  return {
    embeddedCaptures: embedded.length,
    skippedCaptures: skipped,
    candidates,
  };
}
