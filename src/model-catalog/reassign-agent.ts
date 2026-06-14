/**
 * Builds the session-store patch that reassigns an agent off a deprecated model.
 *
 * An agent's model pin lives in its session entry as
 * `modelOverride`/`providerOverride`/`modelOverrideSource`. Rewrite points the
 * override at the qualified replacement; clear (no survivor) unsets the override
 * so the agent falls back to the configured default instead of a dead model. The
 * doctor `--fix` flow applies the returned patch via `applySessionStoreEntryPatch`.
 */
import {
  buildModelCatalogRef,
  normalizeModelCatalogProviderId,
} from "@openclaw/model-catalog-core/model-catalog-refs";
import type { SessionEntry } from "./../config/sessions/types.js";
import type { ReassignmentAction } from "./reassign-plan.js";

/** Source marker for reassigned overrides: system-chosen, not a fresh user pin. */
const REASSIGNED_SOURCE = "auto" as const;

/**
 * Returns the session-entry patch for an `agent-model` action, or null for other
 * binding kinds. A `rewrite` repoints the override; a `clear` unsets it (explicit
 * undefined fields are dropped by the merge + JSON serialization).
 */
export function buildAgentModelPatch(action: ReassignmentAction): Partial<SessionEntry> | null {
  if (action.binding.kind !== "agent-model") {
    return null;
  }
  if (action.outcome === "clear") {
    return {
      modelOverride: undefined,
      providerOverride: undefined,
      modelOverrideSource: undefined,
    };
  }
  const provider = normalizeModelCatalogProviderId(action.binding.ref.provider);
  return {
    modelOverride: buildModelCatalogRef(provider, action.replacementModelId),
    providerOverride: provider,
    modelOverrideSource: REASSIGNED_SOURCE,
  };
}
