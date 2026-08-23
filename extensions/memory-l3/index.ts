import { registerContextEngine } from "openclaw/plugin-sdk/memory-core-engine-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createHierarchicalL3Engine } from "./src/engine.js";
import {
  createArchiveSearchTool,
  createForgettingCandidatesTool,
  createMemoryInsightsTool,
} from "./src/insights.js";

export default definePluginEntry({
  id: "memory-l3",
  name: "Hierarchical Memory (L1/L2/L3)",
  description:
    'Layered memory: sliding-window L1, chunk fact-list L2, epoch digest L3. Opt-in via plugins.slots.contextEngine: "memory-l3".',
  kind: "context-engine",
  register(api) {
    registerContextEngine("memory-l3", (ctx) => createHierarchicalL3Engine(ctx));
    api.registerTool((ctx) => createMemoryInsightsTool(ctx));
    // Raw-archive BM25 search (read-only) over l1_archive turns.
    api.registerTool((ctx) => createArchiveSearchTool(ctx));
    // memory_forgetting is allowlisted in the copilot replay shim and
    // SAFE_READ_ONLY_TOOLS; without this the tool never exists and both entries
    // are dead.
    api.registerTool((ctx) => createForgettingCandidatesTool(ctx));
  },
});
