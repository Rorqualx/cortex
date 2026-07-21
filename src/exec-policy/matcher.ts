import type { PrefixRule, BannedPrefix, PolicyEvaluation, ExecPolicyDecision } from "./types.js";

/**
 * Normalize a token for matching (lowercase, trim).
 */
function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

/**
 * Parse a pattern string like "git status" or ["git", "status"] into tokens.
 */
export function parsePatternTokens(pattern: string | string[]): string[] {
  if (Array.isArray(pattern)) {
    return pattern.map(normalizeToken);
  }
  return pattern.split(/\s+/).map(normalizeToken).filter(Boolean);
}

/**
 * Parse a pattern field from TOML into the alternatives format.
 * pattern: ["git", "status"] → [["git"], ["status"]]
 * pattern: [["git", "rg"], "status"] → [["git", "rg"], ["status"]]
 */
export function parseAlternatives(
  pattern: string | string[] | Array<string | string[]>,
): string[][] {
  if (!Array.isArray(pattern)) {
    return [parsePatternTokens(pattern)];
  }
  return pattern.map((item) => {
    if (Array.isArray(item)) {
      return item.map(normalizeToken).filter(Boolean);
    }
    return parsePatternTokens(item);
  });
}

/**
 * Check if command tokens match a prefix rule pattern.
 * Each pattern element is a set of alternatives that must match
 * the corresponding command token.
 */
export function matchesPrefix(commandTokens: string[], pattern: string[][]): boolean {
  if (pattern.length === 0) {
    return false;
  }
  if (commandTokens.length < pattern.length) {
    return false;
  }

  for (let i = 0; i < pattern.length; i++) {
    const alternatives = pattern[i];
    const commandToken = commandTokens[i];
    // `?.`: i < pattern.length keeps the index in bounds; an impossible hole
    // simply fails the match instead of throwing.
    if (!alternatives?.some((alt) => alt === commandToken)) {
      return false;
    }
  }
  return true;
}

/**
 * Tokenize a shell command string into tokens.
 * Simple shlex-like splitting: respects single and double quotes,
 * backslash escapes.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        tokens.push(normalizeToken(current));
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    tokens.push(normalizeToken(current));
  }
  return tokens;
}

/**
 * Evaluate a command against a set of prefix rules.
 * Returns all matching rules.
 */
export function evaluateRules(commandTokens: string[], rules: PrefixRule[]): PrefixRule[] {
  const matched: PrefixRule[] = [];
  for (const rule of rules) {
    if (matchesPrefix(commandTokens, rule.pattern)) {
      matched.push(rule);
    }
  }
  return matched;
}

/**
 * Evaluate a command against banned prefixes.
 */
export function evaluateBanned(
  commandTokens: string[],
  banned: BannedPrefix[],
): BannedPrefix | undefined {
  for (const b of banned) {
    if (
      matchesPrefix(
        commandTokens,
        b.pattern.map((p) => [p]),
      )
    ) {
      return b;
    }
  }
  return undefined;
}

/**
 * Resolve the effective decision from matched rules.
 * When multiple rules match at the SAME specificity (same pattern length),
 * strictest wins: forbidden > prompt > allow.
 * When rules match at DIFFERENT specificity, the longest (most specific) match wins.
 */
export function effectiveDecision(matchedRules: PrefixRule[]): ExecPolicyDecision {
  if (matchedRules.length === 0) {
    return "prompt";
  }

  // Group by specificity (pattern length)
  const bySpec = new Map<number, ExecPolicyDecision[]>();
  for (const rule of matchedRules) {
    const len = rule.pattern.length;
    const existing = bySpec.get(len) ?? [];
    existing.push(rule.decision);
    bySpec.set(len, existing);
  }

  // Use the most specific group (longest pattern)
  const maxSpec = Math.max(...bySpec.keys());
  const decisions = bySpec.get(maxSpec) ?? [];

  // Within same specificity, strictest wins
  if (decisions.includes("forbidden")) {
    return "forbidden";
  }
  if (decisions.includes("prompt")) {
    return "prompt";
  }
  return "allow";
}

/**
 * Full evaluation of a command against a policy.
 */
export function evaluatePolicy(
  command: string,
  policy: { rules: Map<string, PrefixRule[]>; banned: BannedPrefix[] },
): PolicyEvaluation {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return { decision: "prompt", matchedRules: [], matched: false };
  }

  // Check banned first
  const bannedMatch = evaluateBanned(tokens, policy.banned);
  if (bannedMatch) {
    return { decision: "forbidden", matchedRules: [], bannedMatch, matched: true };
  }

  // Lookup rules by first token
  const firstToken = tokens[0];
  if (firstToken === undefined) {
    return { decision: "prompt", matchedRules: [], matched: false };
  }
  const rules = policy.rules.get(firstToken) ?? [];

  // Also check wildcard rules ("*" matches everything)
  const wildcardRules = policy.rules.get("*") ?? [];
  const allCandidateRules = [...rules, ...wildcardRules];

  const matchedRules = evaluateRules(tokens, allCandidateRules);

  if (matchedRules.length === 0) {
    return { decision: "prompt", matchedRules: [], matched: false };
  }

  return {
    decision: effectiveDecision(matchedRules),
    matchedRules,
    matched: true,
  };
}
