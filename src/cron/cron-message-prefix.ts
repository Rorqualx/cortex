// Single source of truth for the `[cron:<jobId> <jobName>]` wrapper that cron
// runs prepend to their first turn message. The producer (cron isolated-agent
// run) and the consumers (gateway session title/preview derivation) both use
// these helpers so the format cannot drift between write and read.
//
// The wrapper is a system artifact, not user content: title/preview derivation
// strips it and surfaces the human job name instead.

/** Builds the cron message prefix token, e.g. `[cron:<id> <name>]`. */
export function buildCronMessagePrefix(job: { id: string; name: string }): string {
  return `[cron:${job.id} ${job.name}]`;
}

export type ParsedCronMessagePrefix = {
  /** Human cron job name from the prefix (may be empty if the job had no name). */
  name: string;
  /** Message body after the prefix, with surrounding whitespace trimmed. */
  body: string;
};

// id is the first whitespace-free token; name is everything up to the closing
// bracket; the remainder (after optional whitespace) is the body.
const CRON_MESSAGE_PREFIX_RE = /^\[cron:(\S+)\s+([^\]]*)\]\s*/;

/**
 * Parses a cron-prefixed message. Returns null when the text has no cron prefix
 * so callers can fall back to the raw message untouched.
 */
export function parseCronMessagePrefix(message: string): ParsedCronMessagePrefix | null {
  const match = CRON_MESSAGE_PREFIX_RE.exec(message);
  if (!match) {
    return null;
  }
  return {
    name: match[2]?.trim() ?? "",
    body: message.slice(match[0].length).trim(),
  };
}
