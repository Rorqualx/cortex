// Axis-counterfactual embedding drift helpers (QW2, 2026-11-14 — Axis-LoRA
// diagnostic slice). Pure functions, no side effects, importable from tests
// and from temporal-survival-audit.mjs.
//
// Purpose: measure how much the memory embedding provider's vectors move when
// ONLY the time axis of a fact's text changes (dates shifted, month names
// swapped, clock times bumped). Frozen/axis-blind embeddings barely move on
// such swaps — the retrieval-side root cause of temporal misses (cf. the
// 2.9% temporal-survival baseline). The distribution over surviving L3 facts
// gates the pplx-embed-v2 provider-swap decision.
//
// Perturbation regexes are MIRRORED from temporal-survival-audit.mjs
// (which mirrors src/compression/temporal.ts) with capture-friendly shapes;
// all run in linear time. Keep in sync.

// Month-token involution swaps (applying twice restores the original).
const MONTH_SWAP = {
  jan: "jul",
  jul: "jan",
  feb: "aug",
  aug: "feb",
  mar: "sep",
  sep: "mar",
  apr: "oct",
  oct: "apr",
  may: "nov",
  nov: "may",
  jun: "dec",
  dec: "jun",
};
const FULL_MONTH_SWAP = {
  jan: "july",
  jul: "january",
  feb: "august",
  aug: "february",
  mar: "september",
  sep: "march",
  apr: "october",
  oct: "april",
  may: "november",
  nov: "may",
  jun: "december",
  dec: "june",
};

const ISO_RE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?Z?/g;
const SLASH_FULL_RE = /\d{4}\/\d{2}\/\d{2}/g;
const SLASH_SHORT_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const MONTH_RE =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\b\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;
const CLOCK_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi;

function shiftLeadingYear(token) {
  return token.replace(/^(\d{4})/, (y) => String(Number.parseInt(y, 10) + 1).padStart(4, "0"));
}

function swapShortSlash(token) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(token);
  if (!m || m[1] === m[2]) {
    return token;
  }
  return `${m[2]}/${m[1]}/${m[3]}`;
}

function swapMonthInToken(token) {
  const word = token.match(/[A-Za-z]+/);
  if (!word) {
    return token;
  }
  const raw = word[0];
  const prefix = raw.slice(0, 3).toLowerCase();
  if (!MONTH_SWAP[prefix]) {
    return token;
  }
  // Full month names (incl. "sept") swap to the full counterpart; 3-letter
  // abbreviations swap to the 3-letter counterpart. First-letter case of the
  // original token is preserved.
  const swapped = raw.length > 3 ? FULL_MONTH_SWAP[prefix] : MONTH_SWAP[prefix];
  const cased =
    raw[0] === raw[0].toUpperCase() ? swapped[0].toUpperCase() + swapped.slice(1) : swapped;
  return token.replace(raw, cased);
}

function shiftClock(token) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i.exec(token.trim());
  if (!m) {
    return token;
  }
  const hadAmpm = Boolean(m[3]);
  let h = Number.parseInt(m[1], 10);
  h = hadAmpm ? (h === 12 ? 1 : h + 1) : (h + 1) % 24;
  return token.replace(/^\d{1,2}/, String(h));
}

/**
 * Deterministically perturb every temporal token in `text` along the time
 * axis: ISO/slash years +1, short slash day/month swapped, month names
 * swapped (involution), clock times +1h. Non-temporal text is untouched.
 * Note: the clock inside an already-shifted ISO timestamp may shift too —
 * still a pure time-axis change; determinism is what matters for the metric.
 * Applying twice does NOT restore the original (year and clock shift are
 * additive, not involutive).
 */
export function perturbTimeAxis(text) {
  return String(text ?? "")
    .replace(ISO_RE, shiftLeadingYear)
    .replace(SLASH_FULL_RE, shiftLeadingYear)
    .replace(SLASH_SHORT_RE, swapShortSlash)
    .replace(MONTH_RE, swapMonthInToken)
    .replace(CLOCK_RE, shiftClock);
}

/** Cosine similarity of two equal-length vectors; null when degenerate. */
export function cosine(a, b) {
  const n = Math.min(a?.length ?? 0, b?.length ?? 0);
  if (n === 0) {
    return null;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) {
    return null;
  }
  return dot / Math.sqrt(na * nb);
}

/**
 * Summary of a drift distribution (1 - cosine per fact): mean/median/p90/
 * min/max plus the count of axis-blind facts below `blindThreshold`
 * (embeddings that barely move when the time axis changes).
 */
export function summarizeDrift(values, blindThreshold = 0.01) {
  const sorted = [...(values ?? [])].sort((x, y) => x - y);
  const n = sorted.length;
  if (n === 0) {
    return { n: 0, mean: null, median: null, p90: null, min: null, max: null, axisBlind: 0 };
  }
  const quantile = (q) => sorted[Math.min(n - 1, Math.floor(q * n))];
  return {
    n,
    mean: sorted.reduce((s, v) => s + v, 0) / n,
    median: quantile(0.5),
    p90: quantile(0.9),
    min: sorted[0],
    max: sorted[n - 1],
    axisBlind: sorted.filter((v) => v < blindThreshold).length,
  };
}
