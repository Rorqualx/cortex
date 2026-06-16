import fs from "node:fs";
import path from "node:path";
import { buildDefaultPolicy, getDefaultRules, getDefaultBanned } from "./defaults.js";
import { resolvePolicyPath, loadPolicyFromFile, indexRules } from "./parser.js";
import type { PrefixRule, BannedPrefix, ExecPolicy } from "./types.js";

let cachedPolicy: ExecPolicy | null = null;
let cachedHash: string | null = null;

function fileHash(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/**
 * Generate a default TOML file at the policy path.
 * Only writes if no file exists yet.
 */
export function ensureDefaultPolicyFile(): void {
  const filePath = resolvePolicyPath();
  if (fs.existsSync(filePath)) return;

  const lines: string[] = [
    "# OpenClaw Exec Policy",
    "# Controls which shell commands are auto-approved, require approval, or are forbidden.",
    "#",
    "# Format:",
    "#   [[rule]]",
    '#   pattern = ["command", "subcommand"]',
    '#   decision = "allow" | "prompt" | "forbidden"',
    '#   justification = "Why this decision"',
    "#",
    "# Strictest decision wins (forbidden > prompt > allow).",
    "# If no rule matches, the command falls through to the existing approval system.",
    "# Changes are picked up automatically.",
    "",
  ];

  // Generate sections
  lines.push("# === Git (read-only) ===");
  const defaultRules = getDefaultRules();
  for (const r of defaultRules.filter(
    (r) => r.pattern[0]?.[0] === "git" && r.decision === "allow",
  )) {
    const p = r.pattern.map((a) =>
      a.length === 1 ? `"${a[0]}"` : `[${a.map((x) => `"${x}"`).join(", ")}]`,
    );
    lines.push("[[rule]]");
    lines.push(`pattern = [${p.join(", ")}]`);
    lines.push(`decision = "${r.decision}"`);
    if (r.justification) lines.push(`justification = "${r.justification}"`);
    lines.push("");
  }

  lines.push("# === Forbidden commands ===");
  for (const r of defaultRules.filter((r) => r.decision === "forbidden")) {
    const p = r.pattern.map((a) =>
      a.length === 1 ? `"${a[0]}"` : `[${a.map((x) => `"${x}"`).join(", ")}]`,
    );
    lines.push("[[rule]]");
    lines.push(`pattern = [${p.join(", ")}]`);
    lines.push(`decision = "${r.decision}"`);
    if (r.justification) lines.push(`justification = "${r.justification}"`);
    lines.push("");
  }

  lines.push("# === Banned prefixes (always forbidden) ===");
  for (const b of getDefaultBanned()) {
    lines.push("[[banned]]");
    lines.push(`pattern = [${b.pattern.map((p) => `"${p}"`).join(", ")}]`);
    if (b.justification) lines.push(`justification = "${b.justification}"`);
    lines.push("");
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, lines.join("\n"), { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort */
  }
}

/**
 * Load the effective policy. Merges default rules with user overrides.
 * User rules override defaults for the same first token.
 */
export function loadPolicy(): ExecPolicy {
  const filePath = resolvePolicyPath();
  const hash = fileHash(filePath);

  // Return cached if unchanged
  if (cachedPolicy && hash === cachedHash) {
    return cachedPolicy;
  }

  const userPolicy = loadPolicyFromFile(filePath);

  if (!userPolicy) {
    const policy = buildDefaultPolicy();
    cachedPolicy = policy;
    cachedHash = hash;
    return policy;
  }

  // Merge: user rules take precedence over defaults
  const defaultRules = getDefaultRules();
  const defaultBanned = getDefaultBanned();

  const userRuleSigs = new Set<string>();
  for (const r of userPolicy.rules) {
    const sig = r.pattern.map((a) => a.join("|")).join("\u2192");
    userRuleSigs.add(sig);
  }

  const mergedRules: PrefixRule[] = [
    ...userPolicy.rules,
    ...defaultRules.filter((r) => {
      const sig = r.pattern.map((a) => a.join("|")).join("\u2192");
      return !userRuleSigs.has(sig);
    }),
  ];

  const mergedBanned: BannedPrefix[] = [
    ...userPolicy.banned,
    ...defaultBanned.filter(
      (db) => !userPolicy.banned.some((ub) => ub.pattern.join(" ") === db.pattern.join(" ")),
    ),
  ];

  const policy: ExecPolicy = {
    rules: indexRules(mergedRules),
    allRules: mergedRules,
    banned: mergedBanned,
    isDefault: false,
    // Web egress is user-only: defaults never restrict it, so existing users are unaffected.
    ...(userPolicy.web ? { web: userPolicy.web } : {}),
  };

  cachedPolicy = policy;
  cachedHash = hash;
  return policy;
}

/**
 * Force reload the policy (e.g., after amendment).
 */
export function reloadPolicy(): ExecPolicy {
  cachedPolicy = null;
  cachedHash = null;
  return loadPolicy();
}
