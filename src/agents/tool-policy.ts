import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW } from "./sandbox-tool-policy.js";
import { expandToolGroups, normalizeToolList, normalizeToolName } from "./tool-policy-shared.js";
export {
  couldNormalizeToolNamePrefixToAllowedTool,
  expandToolGroups,
  normalizeToolList,
  normalizeToolName,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy-shared.js";
export type { ToolProfileId } from "./tool-policy-shared.js";

/**
 * DENY-FIRST SECURITY RULE
 *
 * OpenClaw enforces a deny-first security model: any tool in a deny list
 * is BLOCKED, even if it appears in an allow list. This is a fundamental
 * security principle - deny ALWAYS overrides allow.
 *
 * The tool policy pipeline processes deny lists before allow lists, and any
 * tool matching a deny pattern is removed from consideration before allow
 * patterns are evaluated.
 *
 * This means adding a tool to `tools.deny` at any policy level
 * (profile, agent, provider, group) will block it, regardless of
 * allowlist entries at other levels.
 *
 * Tool policy evaluation order:
 * 1. Collect all deny lists from all policy sources
 * 2. Remove any tool matching a deny pattern
 * 3. Only then apply allowlist restrictions
 * 4. Tools must survive BOTH checks to be available
 */
export const DENY_FIRST_RULE = Symbol.for("openclaw.denyFirstRule");

export type ToolPolicyLike = {
  allow?: string[];
  deny?: string[];
  [IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW]?: true;
};

export type PluginToolGroups = {
  all: string[];
  byPlugin: Map<string, string[]>;
};

export type AllowlistResolution = {
  policy: ToolPolicyLike | undefined;
  unknownAllowlist: string[];
  pluginOnlyAllowlist: boolean;
};

export const DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY = "__openclaw_default_plugin_tools__";

export function hasRestrictiveAllowPolicy(policy?: { allow?: string[] }): boolean {
  return (
    Array.isArray(policy?.allow) &&
    policy.allow.some((entry) => {
      const normalized = normalizeToolName(entry);
      return (
        Boolean(normalized) &&
        normalized !== "*" &&
        normalized !== DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY
      );
    })
  );
}

export function replaceWithEffectiveToolAllowlist(
  target: string[],
  tools: Array<{ name: string }>,
): void {
  target.length = 0;
  const seen = new Set<string>();
  for (const tool of tools) {
    const normalized = normalizeToolName(tool.name);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    target.push(normalized);
  }
}

export function collectExplicitAllowlist(policies: Array<ToolPolicyLike | undefined>): string[] {
  const entries: string[] = [];
  for (const policy of policies) {
    if (!policy?.allow) {
      continue;
    }
    for (const value of policy.allow) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed === "*" && policy[IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW] === true) {
        continue;
      }
      if (trimmed) {
        entries.push(trimmed);
      }
    }
    if (policy[IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW] === true) {
      entries.push(DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY);
    }
  }
  return uniqueStrings(entries);
}

export function collectExplicitDenylist(policies: Array<ToolPolicyLike | undefined>): string[] {
  const entries: string[] = [];
  for (const policy of policies) {
    if (!policy?.deny) {
      continue;
    }
    for (const value of policy.deny) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed) {
        entries.push(trimmed);
      }
    }
  }
  return entries;
}

export function buildPluginToolGroups<T extends { name: string }>(params: {
  tools: T[];
  toolMeta: (tool: T) => { pluginId: string } | undefined;
}): PluginToolGroups {
  const all: string[] = [];
  const byPlugin = new Map<string, string[]>();
  for (const tool of params.tools) {
    const meta = params.toolMeta(tool);
    if (!meta) {
      continue;
    }
    const name = normalizeToolName(tool.name);
    all.push(name);
    const pluginId = normalizeOptionalLowercaseString(meta.pluginId);
    if (!pluginId) {
      continue;
    }
    const list = byPlugin.get(pluginId) ?? [];
    list.push(name);
    byPlugin.set(pluginId, list);
  }
  return { all, byPlugin };
}

export function expandPluginGroups(
  list: string[] | undefined,
  groups: PluginToolGroups,
): string[] | undefined {
  if (!list || list.length === 0) {
    return list;
  }
  const expanded: string[] = [];
  for (const entry of list) {
    const normalized = normalizeToolName(entry);
    if (normalized === "group:plugins") {
      if (groups.all.length > 0) {
        expanded.push(...groups.all);
      } else {
        expanded.push(normalized);
      }
      continue;
    }
    const tools = groups.byPlugin.get(normalized);
    if (tools && tools.length > 0) {
      expanded.push(...tools);
      continue;
    }
    expanded.push(normalized);
  }
  return uniqueStrings(expanded);
}

export function expandPolicyWithPluginGroups(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
): ToolPolicyLike | undefined {
  if (!policy) {
    return undefined;
  }
  return {
    allow: expandPluginGroups(policy.allow, groups),
    deny: expandPluginGroups(policy.deny, groups),
  };
}

export function analyzeAllowlistByToolType(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
  coreTools: Set<string>,
): AllowlistResolution {
  if (!policy?.allow || policy.allow.length === 0) {
    return { policy, unknownAllowlist: [], pluginOnlyAllowlist: false };
  }
  const normalized = normalizeToolList(policy.allow);
  if (normalized.length === 0) {
    return { policy, unknownAllowlist: [], pluginOnlyAllowlist: false };
  }
  const pluginIds = new Set(groups.byPlugin.keys());
  const pluginTools = new Set(groups.all);
  const unknownAllowlist: string[] = [];
  let hasOnlyPluginEntries = true;
  for (const entry of normalized) {
    if (entry === "*") {
      hasOnlyPluginEntries = false;
      continue;
    }
    const isPluginEntry =
      entry === "group:plugins" || pluginIds.has(entry) || pluginTools.has(entry);
    const expanded = expandToolGroups([entry]);
    const isCoreEntry = expanded.some((tool) => coreTools.has(tool));
    if (!isPluginEntry) {
      hasOnlyPluginEntries = false;
    }
    if (!isCoreEntry && !isPluginEntry) {
      unknownAllowlist.push(entry);
    }
  }
  const pluginOnlyAllowlist = hasOnlyPluginEntries;
  return {
    policy,
    unknownAllowlist: uniqueStrings(unknownAllowlist),
    pluginOnlyAllowlist,
  };
}

export function mergeAlsoAllowPolicy<TPolicy extends { allow?: string[] }>(
  policy: TPolicy | undefined,
  alsoAllow?: string[],
): TPolicy | undefined {
  if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) {
    return policy;
  }
  return { ...policy, allow: uniqueStrings([...policy.allow, ...alsoAllow]) };
}

/**
 * Apply deny-first rule to tool names.
 *
 * Removes denied tools FIRST, before applying allowlist restrictions.
 * This enforces the fundamental security principle that deny ALWAYS overrides allow.
 *
 * @param tools - Tool names to filter
 * @param denylist - Tools to deny (may include glob patterns)
 * @param allowlist - Tools to allow (may include glob patterns)
 * @returns Filtered tool names respecting deny-first rule
 */
export function applyDenyFirstRule(params: {
  tools: string[];
  denylist?: string[];
  allowlist?: string[];
}): string[] {
  const { tools, denylist = [], allowlist = [] } = params;

  // Expand tool groups (e.g., "group:plugins" -> actual tool names)
  const expandedDeny = expandToolGroups(denylist);
  const expandedAllow = expandToolGroups(allowlist);

  // Step 1: Remove denied tools FIRST (deny-first rule)
  const deniedSet = new Set(expandedDeny.map(normalizeToolName).filter(Boolean));

  // Special handling for wildcard deny (*)
  const hasDenyAll = deniedSet.has("*");

  const afterDeny = tools.filter((name) => {
    const normalized = normalizeToolName(name);
    // Wildcard deny removes everything
    if (hasDenyAll) return false;
    return !deniedSet.has(normalized);
  });

  // Step 2: Only then apply allowlist restriction
  const allowSet = new Set(expandedAllow.map(normalizeToolName).filter(Boolean));

  // If allowlist is empty or has wildcard, all non-denied tools pass
  if (expandedAllow.length === 0 || allowSet.has("*")) {
    return afterDeny;
  }

  return afterDeny.filter((name) => {
    const normalized = normalizeToolName(name);
    return allowSet.has(normalized);
  });
}

/**
 * Detect conflicts between deny and allow lists.
 *
 * Returns tools that appear in both deny and allow lists, indicating
 * a potential policy conflict that should be resolved.
 *
 * @param policies - Array of policies to check for conflicts
 * @returns Object containing conflicting tool names by policy index
 */
export function detectDenyAllowConflicts(
  policies: Array<ToolPolicyLike | undefined>,
): Record<number, string[]> {
  const conflicts: Record<number, string[]> = {};

  for (let i = 0; i < policies.length; i++) {
    const policy = policies[i];
    if (!policy) continue;

    const deny = new Set((policy.deny ?? []).map(normalizeToolName).filter(Boolean));
    const allow = new Set((policy.allow ?? []).map(normalizeToolName).filter(Boolean));

    const conflicting: string[] = [];
    for (const tool of deny) {
      // Check if this denied tool is also explicitly allowed
      if (allow.has(tool) || allow.has("*")) {
        conflicting.push(tool);
      }
    }

    // Also check expanded tool groups
    const expandedDeny = expandToolGroups(policy.deny ?? []);
    const expandedAllow = expandToolGroups(policy.allow ?? []);
    const expandedAllowSet = new Set(expandedAllow.map(normalizeToolName));

    for (const tool of expandedDeny) {
      const normalized = normalizeToolName(tool);
      if (expandedAllowSet.has(normalized) && !conflicting.includes(normalized)) {
        conflicting.push(normalized);
      }
    }

    if (conflicting.length > 0) {
      conflicts[i] = uniqueStrings(conflicting);
    }
  }

  return conflicts;
}
