/**
 * Collects the places a model id is pinned (cron payload model + fallbacks,
 * agent session overrides, config aliases) into `ModelBinding`s for the planner.
 *
 * Ref resolution (qualified `provider/model`, bare, or alias) is injected so the
 * collectors stay unit-testable without the runtime resolver; the doctor flow
 * wires `resolveRef` to `resolveModelRefFromString` + the alias index.
 */
import type { CronStoreFile } from "../cron/types.js";
import type { ModelBinding, ResolvedModelRef } from "./reassign-plan.js";

/** Minimal session shape the agent collector reads (matches the snapshot rows). */
export type SessionOverrideEntry = {
  readonly modelOverride?: string;
  readonly providerOverride?: string;
};

/** Resolves a raw model ref string (with optional provider hint) to provider+id. */
export type ResolveRef = (raw: string, providerHint?: string) => ResolvedModelRef | null;

/** Cron bindings: payload model + each fallback entry of every agentTurn job. */
export function collectCronBindings(store: CronStoreFile, resolveRef: ResolveRef): ModelBinding[] {
  const bindings: ModelBinding[] = [];
  for (const job of store.jobs) {
    if (job.payload.kind !== "agentTurn") {
      continue;
    }
    if (job.payload.model) {
      const ref = resolveRef(job.payload.model);
      if (ref) {
        bindings.push({ kind: "cron-model", jobId: job.id, ref });
      }
    }
    job.payload.fallbacks?.forEach((fallback, index) => {
      const ref = resolveRef(fallback);
      if (ref) {
        bindings.push({ kind: "cron-fallback", jobId: job.id, index, ref });
      }
    });
  }
  return bindings;
}

/** Agent bindings: each session entry's model override, resolved with its provider hint. */
export function collectAgentBindings(
  agentId: string,
  entries: Iterable<readonly [string, SessionOverrideEntry]>,
  resolveRef: ResolveRef,
): ModelBinding[] {
  const bindings: ModelBinding[] = [];
  for (const [sessionKey, entry] of entries) {
    const raw = entry.modelOverride?.trim();
    if (!raw) {
      continue;
    }
    const ref = resolveRef(raw, entry.providerOverride?.trim() || undefined);
    if (ref) {
      bindings.push({ kind: "agent-model", agentId, sessionKey, ref });
    }
  }
  return bindings;
}

/** Alias bindings: one per configured alias, resolved to its target model. */
export function collectAliasBindings(
  aliases: Iterable<{ alias: string; ref: ResolvedModelRef }>,
): ModelBinding[] {
  const bindings: ModelBinding[] = [];
  for (const { alias, ref } of aliases) {
    bindings.push({ kind: "alias", alias, ref });
  }
  return bindings;
}
