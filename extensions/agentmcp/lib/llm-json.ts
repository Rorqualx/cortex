// Shared parser for JSON returned by an LLM. Two failure modes we routinely
// see in the wild: (1) the model wraps its JSON in markdown fences despite
// being told not to, and (2) the model adds a friendly preamble or trailing
// chatter around an otherwise-valid JSON object. Both are recoverable; this
// util attempts each in turn and tags the failure mode so callers can decide
// whether to retry.

export type LlmJsonError =
  | { kind: "fences"; message: string }
  | { kind: "chatter"; message: string }
  | { kind: "parse"; message: string }
  | { kind: "shape"; message: string };

export type LlmJsonResult = { ok: unknown } | { err: LlmJsonError };

const FENCE_OPEN = /^\s*```(?:json)?\s*/i;
const FENCE_CLOSE = /\s*```\s*$/i;

export function parseLlmJson(raw: string): LlmJsonResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { err: { kind: "parse", message: "empty response" } };
  }

  // Attempt 1: strip fences (if any) and parse directly.
  const defenced = trimmed.replace(FENCE_OPEN, "").replace(FENCE_CLOSE, "");
  const direct = tryParse(defenced);
  if ("ok" in direct) {
    return direct;
  }

  // Attempt 2: extract the first balanced {...} block from the raw text. This
  // handles "Sure, here's the JSON: {...}" or "{...}\n\nLet me know if you
  // need anything else." Strings are respected so a `}` inside a JSON string
  // doesn't close the block prematurely.
  const extracted = extractFirstJsonObject(trimmed);
  if (extracted !== null) {
    const second = tryParse(extracted);
    if ("ok" in second) {
      return second;
    }
    return {
      err: { kind: "parse", message: `extracted block failed parse: ${second.err.message}` },
    };
  }

  // No salvage path worked. Tag the failure based on the most plausible cause.
  if (FENCE_OPEN.test(trimmed) || FENCE_CLOSE.test(trimmed)) {
    return { err: { kind: "fences", message: "fenced content failed to parse" } };
  }
  if (trimmed.includes("{")) {
    return { err: { kind: "chatter", message: "no balanced {...} block could be extracted" } };
  }
  return { err: { kind: "parse", message: "no JSON object found in response" } };
}

function tryParse(s: string): { ok: unknown } | { err: { message: string } } {
  try {
    return { ok: JSON.parse(s) };
  } catch (e) {
    return { err: { message: (e as Error).message } };
  }
}

// Walk the string finding the first balanced {...} block. Tracks string state
// so braces inside JSON strings don't affect depth; tracks escapes so an
// escaped quote inside a string doesn't end the string. Returns the block
// (inclusive of outer braces) or null if no balanced block is found.
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}
