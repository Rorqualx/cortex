/**
 * Cross-context memory — shared long-term fact store across agents/sessions.
 *
 * ZenBrain Layer 7: agents, cron-spawned sessions, and sub-agents all share
 * a common long-term fact store at `~/.openclaw/shared-memory/longterm-shared.json`.
 * Each agent publishes its promoted long-term facts after consolidation;
 * retrieval includes shared facts as a cross-context tier.
 *
 * Conflict resolution: when multiple agents promote facts with the same
 * dedupKey, the fact with the highest importance wins. Superseded facts
 * are archived (not deleted) for forensics.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LongTermFact } from "./types.js";

export type SharedLongTermFact = LongTermFact & {
  /** Agent ID that originally promoted this fact. */
  sourceAgentId: string;
};

export type SharedStore = {
  version: 1;
  facts: SharedLongTermFact[];
  lastUpdatedAt: number;
};

const INITIAL_SHARED_STORE: SharedStore = {
  version: 1,
  facts: [],
  lastUpdatedAt: 0,
};

/**
 * Resolve the shared memory directory path.
 * Defaults to `~/.openclaw/shared-memory/`; override via env or param.
 */
export function resolveSharedMemoryDir(override?: string): string {
  if (override && override.length > 0) {
    return override;
  }
  const fromEnv = process.env.OPENCLAW_SHARED_MEMORY_DIR;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".openclaw", "shared-memory");
}

/**
 * Read shared facts from the store. Returns empty array when missing.
 */
export async function readSharedFacts(sharedDir?: string): Promise<SharedLongTermFact[]> {
  const dir = resolveSharedMemoryDir(sharedDir);
  const target = path.join(dir, "longterm-shared.json");
  try {
    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as SharedStore;
    return Array.isArray(parsed.facts) ? parsed.facts : [];
  } catch (err) {
    if (isNotFound(err)) {
      return [];
    }
    throw err;
  }
}

/**
 * Write shared facts to the store atomically.
 */
export async function writeSharedFacts(
  facts: SharedLongTermFact[],
  sharedDir?: string,
): Promise<void> {
  const dir = resolveSharedMemoryDir(sharedDir);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, "longterm-shared.json");
  const store: SharedStore = {
    version: 1,
    facts,
    lastUpdatedAt: Date.now(),
  };
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fs.rename(tmp, target);
}

/**
 * Merge key for dedup: combines agent ID and dedupKey so each agent's
 * version of a fact is tracked independently before conflict resolution.
 */
function mergeKey(fact: SharedLongTermFact): string {
  return `${fact.sourceAgentId}::${fact.dedupKey}`;
}

/**
 * Publish an agent's promoted long-term facts into the shared store.
 * Dedupes by (agentId + dedupKey), keeping the most recent version.
 * Then runs conflict resolution for cross-agent dedupKey collisions.
 */
export async function publishToFacts(
  agentId: string,
  facts: ReadonlyArray<LongTermFact>,
  sharedDir?: string,
): Promise<{ published: number; conflicts: number }> {
  const existing = await readSharedFacts(sharedDir);
  const activeExisting = existing.filter((f) => !f.archived);

  // Stamp agent ID on new facts
  const newShared: SharedLongTermFact[] = facts
    .filter((f) => !f.archived)
    .map((f) => ({ ...f, sourceAgentId: agentId }));

  // Merge: dedupe by (agentId + dedupKey), keep most recent
  const merged = new Map<string, SharedLongTermFact>();
  for (const fact of activeExisting) {
    merged.set(mergeKey(fact), fact);
  }
  for (const fact of newShared) {
    const key = mergeKey(fact);
    const current = merged.get(key);
    if (!current || fact.lastConfirmedAt >= current.lastConfirmedAt) {
      merged.set(key, fact);
    }
  }

  // Also preserve archived facts for forensics
  const archived = existing.filter((f) => f.archived);

  // Conflict resolution: same dedupKey from different agents
  const allActive = Array.from(merged.values());
  const resolved = resolveConflicts(allActive);

  const finalFacts = [...resolved, ...archived];
  await writeSharedFacts(finalFacts, sharedDir);

  const conflicts = allActive.length - resolved.filter((f) => !f.archived).length;
  return { published: newShared.length, conflicts: Math.max(0, -conflicts) };
}

/**
 * Resolve cross-agent conflicts: when the same dedupKey appears from
 * multiple agents, keep the fact with the highest importance and archive
 * the rest. Facts already archived are left alone.
 */
export function resolveConflicts(facts: ReadonlyArray<SharedLongTermFact>): SharedLongTermFact[] {
  const byDedupKey = new Map<string, SharedLongTermFact[]>();
  for (const fact of facts) {
    if (fact.archived) {
      continue;
    }
    const list = byDedupKey.get(fact.dedupKey) ?? [];
    list.push(fact);
    byDedupKey.set(fact.dedupKey, list);
  }

  const result: SharedLongTermFact[] = [];
  for (const [dedupKey, candidates] of byDedupKey) {
    if (candidates.length <= 1) {
      result.push(...candidates);
      continue;
    }
    // Sort by importance descending, then by lastConfirmedAt as tiebreaker
    candidates.sort((a, b) => {
      const impDiff = b.importance - a.importance;
      if (Math.abs(impDiff) > 0.001) {
        return impDiff;
      }
      return b.lastConfirmedAt - a.lastConfirmedAt;
    });
    // Winner stays active; rest get archived
    result.push(candidates[0]);
    for (let i = 1; i < candidates.length; i++) {
      result.push({
        ...candidates[i],
        archived: true,
        archivedAt: candidates[i].archivedAt ?? Date.now(),
      });
    }
  }

  return result;
}

function isNotFound(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "ENOENT",
  );
}
