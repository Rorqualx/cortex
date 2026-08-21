/**
 * Temporal-anchor detection for the compression pipeline.
 *
 * Deterministic counterpart of the memory-l3 temporal-preservation prompt rule
 * (F8 residual, arXiv:2608.11775 class): the compression pipeline is the surface
 * that can silently drop dates and times from tool results. Items, lines, and
 * messages that carry explicit temporal anchors (dates, clock times, month-day
 * references) are preferentially retained so temporal grounding survives
 * compression and can drive later retrieval.
 *
 * All patterns run in linear time (no nested or overlapping quantifiers).
 */

const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?Z?/;
const SLASH_DATE_RE = /\d{4}\/\d{2}\/\d{2}|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;
const CLOCK_TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/i;
const MONTH_NAME_RE =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\b\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

/**
 * True when the text contains an explicit temporal anchor: an ISO-style date or
 * timestamp, a slash-formatted date, a clock time, or a month-day reference.
 */
export function hasTemporalAnchor(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  return (
    ISO_DATE_RE.test(text) ||
    SLASH_DATE_RE.test(text) ||
    CLOCK_TIME_RE.test(text) ||
    MONTH_NAME_RE.test(text)
  );
}
