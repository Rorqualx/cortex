import type { OpenClawConfig } from "../config/types.js";
import {
  normalizePluginId,
  normalizePluginsConfig,
  resolveSelectedContextEnginePluginIdFromConfig,
} from "../plugins/config-state.js";
import type { ContextEngineRegistration } from "../plugins/registry-contribution-types.js";
import { defaultSlotIdForKey, preferredSlotIdForKey } from "../plugins/slots.js";
import { pluginIdFromContextEngineOwner } from "./registry-adoption.js";

/** Applies canonical plugin policy to a registered engine without changing its engine ID. */
export function resolveEffectiveContextEngineId(
  config: OpenClawConfig | undefined,
  entries: ReadonlyMap<string, ContextEngineRegistration>,
): string {
  const plugins = normalizePluginsConfig(config?.plugins);
  const configuredEngineId = plugins.slots.contextEngine;
  const defaultEngineId = defaultSlotIdForKey("contextEngine");
  // Unset slot resolves to the preferred engine (memory-l3 in this fork), not
  // the built-in default. A preferred engine that is unregistered or disabled
  // by config fails the checks below and degrades to the default engine id.
  const engineId =
    typeof configuredEngineId === "string" && configuredEngineId.trim()
      ? configuredEngineId.trim()
      : preferredSlotIdForKey("contextEngine");
  if (engineId === defaultEngineId) {
    return defaultEngineId;
  }
  const entry = entries.get(engineId);
  // An absent registration retains the existing equal-ID selection contract and failure path.
  const pluginId = (entry && pluginIdFromContextEngineOwner(entry.owner)) ?? engineId;
  return resolveSelectedContextEnginePluginIdFromConfig(plugins, normalizePluginId(pluginId))
    ? engineId
    : defaultEngineId;
}
