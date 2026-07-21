/**
 * ContextTracker — cross-turn awareness of compressed content.
 *
 * Tracks what was compressed across turns so the pipeline can:
 *  1. Proactively expand relevant data when the model asks about something
 *     that was compressed in an earlier turn
 *  2. Provide session-scoped compression history for debugging
 *  3. Clean up tracking state when sessions end
 *
 * This is a per-session in-memory tracker — no persistence needed.
 */

import type { CCREntry } from "../types.js";

export class ContextTracker {
  private entries: CCREntry[] = [];
  /** Keyword index for relevance detection: keyword → entry indices. */
  private keywordIndex = new Map<string, Set<number>>();

  /**
   * Track a compression event for cross-turn awareness.
   */
  trackCompression(entry: CCREntry): void {
    const index = this.entries.length;
    this.entries.push(entry);

    // Index keywords from the original content for relevance detection
    const keywords = this.extractKeywords(entry.originalContent);
    for (const kw of keywords) {
      let indices = this.keywordIndex.get(kw);
      if (!indices) {
        indices = new Set();
        this.keywordIndex.set(kw, indices);
      }
      indices.add(index);
    }
  }

  /**
   * Check if a new query might relate to previously compressed content.
   * Returns matching entries sorted by relevance score.
   */
  detectRelevance(query: string): CCREntry[] {
    const queryKeywords = this.extractKeywords(query);
    if (queryKeywords.length === 0) {
      return [];
    }

    // Score each entry by how many query keywords it matches
    const scores = new Map<number, number>();

    for (const kw of queryKeywords) {
      const indices = this.keywordIndex.get(kw);
      if (indices) {
        for (const idx of indices) {
          scores.set(idx, (scores.get(idx) ?? 0) + 1);
        }
      }
    }

    // Filter to entries with at least 2 keyword matches (or 1 if query is short)
    const threshold = queryKeywords.length >= 3 ? 2 : 1;
    const relevant = [...scores.entries()]
      .filter(([, score]) => score >= threshold)
      .toSorted((a, b) => b[1] - a[1])
      .flatMap(([idx]) => {
        const entry = this.entries[idx];
        return entry ? [entry] : [];
      });

    return relevant;
  }

  /**
   * Get the most recently compressed entries (for session cleanup / debugging).
   */
  getRecentEntries(limit: number = 20): CCREntry[] {
    return this.entries.slice(-limit);
  }

  /**
   * Get all tracked entries.
   */
  getEntries(): CCREntry[] {
    return [...this.entries];
  }

  /**
   * Get the count of tracked entries.
   */
  get count(): number {
    return this.entries.length;
  }

  /**
   * Clear session tracking.
   */
  clear(): void {
    this.entries = [];
    this.keywordIndex.clear();
  }

  // ---------------------------------------------------------------------------
  // Keyword extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract meaningful keywords from content for relevance matching.
   * Lowercased, stripped of punctuation, filtered for length >= 3.
   */
  private extractKeywords(content: string): string[] {
    // For very large content, only index the first 2000 chars
    const sample = content.slice(0, 2000);
    const words = sample
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

    // Deduplicate
    return [...new Set(words)];
  }
}

/**
 * Common English stop words to exclude from keyword matching.
 */
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "her",
  "was",
  "one",
  "our",
  "out",
  "has",
  "had",
  "his",
  "how",
  "its",
  "let",
  "may",
  "new",
  "now",
  "old",
  "see",
  "way",
  "who",
  "did",
  "get",
  "got",
  "him",
  "top",
  "say",
  "she",
  "too",
  "use",
  "this",
  "that",
  "with",
  "from",
  "they",
  "been",
  "said",
  "each",
  "make",
  "like",
  "long",
  "look",
  "many",
  "some",
  "them",
  "than",
  "been",
  "call",
  "come",
  "made",
  "find",
  "more",
  "very",
  "after",
  "also",
  "just",
  "over",
  "such",
  "take",
  "only",
  "when",
  "what",
  "your",
  "know",
  "will",
  "have",
  "into",
  "could",
  "other",
  "about",
  "which",
  "their",
  "there",
  "would",
  "these",
  "click",
  "being",
  "index",
  "those",
  "where",
  "should",
  "first",
  "under",
  "might",
  "while",
  "doing",
]);
