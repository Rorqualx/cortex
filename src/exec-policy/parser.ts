import fs from "node:fs";
import { parse as parseToml } from "smol-toml";
import { expandHomePrefix } from "../infra/home-dir.js";
import { parseAlternatives } from "./matcher.js";
import type { PrefixRule, BannedPrefix, ExecPolicyToml, WebPolicy } from "./types.js";

const DEFAULT_POLICY_PATH = "~/.openclaw/exec-policy.toml";

export function resolvePolicyPath(): string {
  return expandHomePrefix(DEFAULT_POLICY_PATH);
}

function normalizeDecision(value: string): "allow" | "prompt" | "forbidden" {
  const lower = value.toLowerCase().trim();
  if (lower === "allow" || lower === "prompt" || lower === "forbidden") {
    return lower;
  }
  return "prompt"; // Safe default for unknown decisions
}

function parseRuleFromToml(raw: NonNullable<ExecPolicyToml["rule"]>[number]): PrefixRule {
  const pattern = parseAlternatives(raw.pattern as string | string[] | Array<string | string[]>);
  return {
    pattern,
    decision: normalizeDecision(raw.decision),
    justification: raw.justification,
  };
}

function parseBannedFromToml(raw: NonNullable<ExecPolicyToml["banned"]>[number]): BannedPrefix {
  let tokens: string[];
  if (Array.isArray(raw.pattern)) {
    tokens = raw.pattern.map((s) => s.trim().toLowerCase()).filter(Boolean);
  } else {
    tokens = raw.pattern
      .split(/\s+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return {
    pattern: tokens,
    justification: raw.justification,
  };
}

function normalizeHosts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function parseWebFromToml(raw: ExecPolicyToml["web"]): WebPolicy | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const allow = normalizeHosts(raw.allow);
  const deny = normalizeHosts(raw.deny);
  if (allow.length === 0 && deny.length === 0) {
    return undefined;
  }
  return { allow, deny };
}

export function parsePolicyToml(tomlText: string): {
  rules: PrefixRule[];
  banned: BannedPrefix[];
  web?: WebPolicy;
} {
  const parsed = parseToml(tomlText) as unknown as ExecPolicyToml;
  const rules: PrefixRule[] = [];
  const banned: BannedPrefix[] = [];

  if (Array.isArray(parsed.rule)) {
    for (const r of parsed.rule) {
      rules.push(parseRuleFromToml(r));
    }
  }

  if (Array.isArray(parsed.banned)) {
    for (const b of parsed.banned) {
      banned.push(parseBannedFromToml(b));
    }
  }

  return { rules, banned, web: parseWebFromToml(parsed.web) };
}

/**
 * Index rules by first-token alternatives for O(1) lookup.
 */
export function indexRules(rules: PrefixRule[]): Map<string, PrefixRule[]> {
  const index = new Map<string, PrefixRule[]>();
  for (const rule of rules) {
    if (rule.pattern.length === 0) {
      continue;
    }
    const firstAlternatives = rule.pattern[0];
    if (firstAlternatives === undefined) {
      continue;
    }
    for (const alt of firstAlternatives) {
      const existing = index.get(alt) ?? [];
      existing.push(rule);
      index.set(alt, existing);
    }
  }
  return index;
}

export function loadPolicyFromFile(
  filePath: string,
): { rules: PrefixRule[]; banned: BannedPrefix[]; web?: WebPolicy } | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return parsePolicyToml(raw);
  } catch {
    return null;
  }
}
