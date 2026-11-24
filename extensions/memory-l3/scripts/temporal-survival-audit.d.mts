// Type declarations for temporal-survival-audit.mjs. The .mjs intentionally
// stays untyped JS (standalone CLI over node:sqlite); these signatures mirror
// its exported pure helpers so TS import sites type-check. Mirrors the
// compaction-proxy-metrics.d.mts sibling pattern.
export declare function extractAnchors(
  text: string,
): Map<string, Set<string>>;

export declare function countTemporalExpressions(text: string): {
  perCategory: Map<string, number>;
  total: number;
};

export declare function extractAspectForms(
  text: string,
): Map<string, Set<string>>;

export declare function extractLossForms(
  text: string,
): Map<string, Set<string>>;

export declare function countOrderInversions(
  anchors: ReadonlyArray<string>,
  preText: string,
  postText: string,
): { pairs: number; inversions: number };

export declare function messageText(record: unknown): string;

export declare function postHaystack(frontmatterJson: string, body: string): string;

export declare function partitionFactsByOperatorOutput(frontmatterJson: string): {
  plain: string;
  merged: string;
  abstract: string;
};
