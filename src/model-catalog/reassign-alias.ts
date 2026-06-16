/**
 * Pure rewriter for the config alias map (`agents.defaults.models`) used by the
 * doctor `--fix` repair — the one flow permitted to edit openclaw.json. Repoints
 * an alias off a deprecated/superseded model onto its replacement (relabeling to
 * the live discovered display name when one exists, else keeping the user's
 * label), or drops the alias when no replacement survives.
 *
 * Kept pure over a plain map so it is testable without config I/O; the doctor
 * repair clones the config, applies this, and returns the new config to persist.
 */
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { ReassignmentAction } from "./reassign-plan.js";

/** Minimal alias-map shape: model key -> entry carrying an `alias` label. */
export type AliasEntry = { alias?: string } & Record<string, unknown>;
export type AliasModelMap = Record<string, AliasEntry>;

/** One applied alias change, for reporting. */
export type AliasReassignmentChange = {
  alias: string;
  outcome: "repoint" | "drop";
  fromKey: string;
  toKey?: string;
  newLabel?: string;
};

function findAliasKey(map: AliasModelMap, alias: string): string | undefined {
  for (const [key, entry] of Object.entries(map)) {
    if (entry?.alias === alias) {
      return key;
    }
  }
  return undefined;
}

/**
 * Applies alias-kind reassignment actions to a copy of the alias map. Rewrite
 * repoints the entry to the replacement model key; clear drops it. Returns the
 * new map and the changes (empty changes => map is returned structurally equal).
 */
export function applyAliasReassignments(params: {
  aliases: AliasModelMap;
  actions: readonly ReassignmentAction[];
  /** Live display name for a replacement model, when discovery provides one. */
  displayNameFor?: (provider: string, modelId: string) => string | undefined;
}): { aliases: AliasModelMap; changes: AliasReassignmentChange[] } {
  const next: AliasModelMap = { ...params.aliases };
  const changes: AliasReassignmentChange[] = [];
  for (const action of params.actions) {
    if (action.binding.kind !== "alias") {
      continue;
    }
    const { alias } = action.binding;
    const fromKey = findAliasKey(next, alias);
    if (!fromKey) {
      continue;
    }
    const entry = next[fromKey];
    if (action.outcome === "clear") {
      delete next[fromKey];
      changes.push({ alias, outcome: "drop", fromKey });
      continue;
    }
    const toKey = buildModelCatalogRef(action.binding.ref.provider, action.replacementModelId);
    if (toKey === fromKey) {
      continue;
    }
    if (Object.hasOwn(next, toKey)) {
      // The replacement model already has its own alias; repointing would clobber
      // it. Drop the now-redundant source alias instead of overwriting the target.
      delete next[fromKey];
      changes.push({ alias, outcome: "drop", fromKey });
      continue;
    }
    const liveName = params
      .displayNameFor?.(action.binding.ref.provider, action.replacementModelId)
      ?.trim();
    const newLabel = liveName || alias;
    delete next[fromKey];
    next[toKey] = { ...entry, alias: newLabel };
    changes.push({ alias, outcome: "repoint", fromKey, toKey, newLabel });
  }
  return { aliases: next, changes };
}
