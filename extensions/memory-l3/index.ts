import { registerContextEngine } from "openclaw/plugin-sdk";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createHierarchicalL3Engine } from "./src/engine.js";
import { createMemoryInsightsTool, createForgettingCandidatesTool } from "./src/insights.js";

export default definePluginEntry({
  id: "memory-l3",
  name: "Hierarchical Memory (L1/L2/L3)",
  description:
    'Layered memory: sliding-window L1, chunk fact-list L2, epoch digest L3. Opt-in via plugins.slots.contextEngine: "memory-l3".',
  kind: "context-engine",
  register(api) {
    registerContextEngine("memory-l3", (ctx) => createHierarchicalL3Engine(ctx));
    api.registerTool((ctx) => createMemoryInsightsTool(ctx));
    api.registerTool((ctx) => createForgettingCandidatesTool(ctx));
  },
});
