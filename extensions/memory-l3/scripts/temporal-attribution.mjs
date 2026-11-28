// Temporal-loss attribution helpers (QW-A, 2026-11-28).
//
// The temporal-survival audit (temporal-survival-audit.mjs) measures
// pre→post temporal-anchor survival across compaction. Ground-truth from the
// 2026-11-28 re-run: overall survival is ~5.6% even with the v18
// timestamp-preservation clause shipped — so the open question is WHERE
// anchors actually die. These helpers support three attribution moves on
// persisted data only (l1_archive JSONL + l3_l2_chunks rows; the pipeline
// persists no intermediates):
//
//   1. Slice to chunks compacted after the v18 clause landed (created_at
//      filter) — measures the current pipeline, not the historical mix.
//   2. De-noise the pre-side denominator — ambient timestamps from tool
//      outputs, system messages, and OpenClaw runtime-context injections
//      dominate the anchor counts (~30/chunk average) and mask real signal.
//   3. Classify each LOST anchor: "retained-earlier" (the anchor lives in an
//      earlier chunk's distilled output — a cross-chunk dedup drop, not a net
//      memory loss), "retained-later" (re-extracted later — also not a net
//      loss), or "extraction-lost" (gone from the whole store — the only
//      true memory loss, attributable to extraction/merge since the
//      category budget is off by default).
//
// Pure and dependency-free so temporal-survival-audit.mjs and unit tests
// share one implementation.

/** Commit d4e5dc4fadb landed PROMPT_VERSION=18 (timestamp-preservation
 * clause) at 2026-08-16T12:37:40Z. Chunks created after this are the
 * "current pipeline" slice. */
export const V18_LANDED_AT = "2026-08-16T12:37:40Z";

/** Message roles whose timestamps are ambient noise, not signal the
 * conversation actually asserted: tool outputs (OpenAI-style `tool` and the
 * internal `toolResult` shape) and system messages. */
export const AMBIENT_NOISE_ROLES = new Set(["tool", "toolResult", "system"]);

/** True when an l1_archive message record is ambient noise for temporal
 * survival: a tool-output/system role, or an OpenClaw runtime-context
 * injection (`role: "custom"` with `customType: "openclaw.*"`). */
export function isAmbientNoiseRecord(record) {
  if (!record || typeof record !== "object") return true;
  if (typeof record.role === "string" && AMBIENT_NOISE_ROLES.has(record.role)) return true;
  if (typeof record.customType === "string" && record.customType.startsWith("openclaw.")) {
    return true;
  }
  return false;
}

/** Flatten non-noise JSONL message records to prose text. String content and
 * `type: "text"` blocks only — tool-call blocks (whose argument JSON carries
 * timestamps) and thinking/image blocks are excluded from the de-noised
 * denominator. */
export function denoisedTextFromLines(lines) {
  const parts = [];
  for (const line of lines) {
    if (typeof line !== "string" || line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (isAmbientNoiseRecord(record)) continue;
    const content = record.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "string") {
          parts.push(block);
        } else if (
          block &&
          typeof block === "object" &&
          block.type === "text" &&
          typeof block.text === "string"
        ) {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join("\n");
}

/** Parse a --since value. Semantics:
 *   null/undefined → default: the v18 landing timestamp (current-pipeline slice)
 *   "0" or "all"   → 0 (disable the slice; audit all chunks)
 *   numeric string → epoch-ms
 *   ISO date string → Date.parse
 *   anything else  → null (unparseable; caller should exit with an error) */
export function parseSince(value) {
  if (value === null || value === undefined || value === "") {
    return Date.parse(V18_LANDED_AT);
  }
  const trimmed = String(value).trim().toLowerCase();
  if (trimmed === "0" || trimmed === "all") return 0;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/** Classify a lost temporal anchor given the creation times of the OTHER
 * chunks whose distilled output still contains it (sorted ascending; the
 * anchor was already confirmed absent from the owner chunk's own output, so
 * every entry is another chunk by construction).
 *   - any earlier chunk contains it → "retained-earlier" (cross-chunk dedup
 *     drop; the fact was already known — not a net memory loss)
 *   - only later chunks contain it → "retained-later" (re-extracted later;
 *     not a net memory loss)
 *   - no chunk contains it → "extraction-lost" (gone from the store) */
export function attributionForLostAnchor(ownerCreatedAt, containingCreatedAts) {
  const times = Array.isArray(containingCreatedAts) ? containingCreatedAts : [];
  for (const t of times) {
    if (t < ownerCreatedAt) return "retained-earlier";
  }
  return times.length > 0 ? "retained-later" : "extraction-lost";
}
