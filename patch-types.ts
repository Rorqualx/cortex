*** Begin Patch
*** 
*** extensions/memory-l3/src/types.ts
*** 
***  **204,211 ****
***    /** Emotional significance flag propagated from L2 extraction. */
***    significant?: boolean;
***    /**
***     * Pre-computed embedding vector for semantic dedup and retrieval.
***     * Computed at promotion time (or reaffirmation) via the embedding provider.
***     * Absent for facts promoted before this feature was added — fallback to
***     * jaccard for those. Stored as number array (768-dim for nomic-embed-text).
***     */
***    embedding?: number[];
***  --- 
***    /** Emotional significance flag propagated from L2 extraction. */
***    significant?: boolean;
***    /**
***     * Grounding strength used by consolidation thresholds. Absent on facts
***     * extracted before PROMPT_VERSION=8; readers treat absent as "confirmed".
***     */
***    certainty?: FactCertainty;
***    /**
***     * Provenance of the certainty determination. Tracks whether the fact was
***     * originally hedged (tentative language), asserted directly, or corroborated
***     * by multiple sources. Used for scoring reliability adjustments.
***     */
***    certaintyProvenance?: "hedged" | "asserted" | "corroborated";
***    /**
***     * Pre-computed embedding vector for semantic dedup and retrieval.
***     * Computed at promotion time (or reaffirmation) via the embedding provider.
***     * Absent for facts promoted before this feature was added — fallback to
***     * jaccard for those. Stored as number array (768-dim for nomic-embed-text).
***     */
***    embedding?: number[];
*** 
*** *** End Patch ***