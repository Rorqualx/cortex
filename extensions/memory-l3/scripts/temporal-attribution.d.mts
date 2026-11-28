// Type declarations for temporal-attribution.mjs (QW-A loss-attribution
// helpers). The .mjs intentionally stays untyped JS; these signatures mirror
// its exports so TS import sites type-check.
export declare const V18_LANDED_AT: string;
export declare const AMBIENT_NOISE_ROLES: ReadonlySet<string>;
export declare function isAmbientNoiseRecord(record: unknown): boolean;
export declare function denoisedTextFromLines(lines: ReadonlyArray<string>): string;
export declare function parseSince(value: string | null | undefined): number | null;
export declare function attributionForLostAnchor(
  ownerCreatedAt: number,
  containingCreatedAts: ReadonlyArray<number>,
): "retained-earlier" | "retained-later" | "extraction-lost";
