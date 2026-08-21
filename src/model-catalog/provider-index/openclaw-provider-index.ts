// Bundled OpenClaw provider index advertises pre-install provider metadata for model picker discovery.
import type { OpenClawProviderIndex } from "./types.js";

// OpenClaw-owned preview metadata for providers whose plugins may not be
// installed yet. Installed plugin manifests remain authoritative; this index is
// a fallback for installable-provider and pre-install model picker surfaces.
// Preview catalogs use the shared model catalog type, but intentionally keep to
// stable display fields unless runtime adapter metadata is kept in sync with
// the installed plugin manifest.
// When a bundled provider moves to an external package, keep its provider id
// here and add plugin package metadata so pre-install surfaces do not disappear
// before the user installs the new package.
export const OPENCLAW_PROVIDER_INDEX = {
  version: 1,
  providers: {
    moonshot: {
      id: "moonshot",
      name: "Moonshot AI",
      plugin: {
        id: "moonshot",
      },
      docs: "/providers/moonshot",
      categories: ["cloud", "llm"],
      previewCatalog: {
        models: [
          {
            id: "kimi-k2.6",
            name: "Kimi K2.6",
            input: ["text", "image"],
            contextWindow: 262144,
          },
          {
            id: "kimi-k3",
            name: "Kimi K3",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 1048576,
          },
          {
            id: "kimi-k2.7-code",
            name: "Kimi K2.7 Code",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 262144,
          },
          {
            id: "kimi-k2.7-code-highspeed",
            name: "Kimi K2.7 Code HighSpeed",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 262144,
          },
        ],
      },
    },
    deepseek: {
      id: "deepseek",
      name: "DeepSeek",
      plugin: {
        id: "deepseek",
      },
      docs: "/providers/deepseek",
      categories: ["cloud", "llm"],
      previewCatalog: {
        models: [
          {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            input: ["text"],
            reasoning: true,
            contextWindow: 1000000,
          },
          {
            // Experimental vision-input variant of V4 Flash. Capability-flagged
            // only — deliberately NOT added to delegation router defaults or
            // priority chains, so nothing auto-routes to an exp model.
            id: "deepseek-v4-flash-vision-exp",
            name: "DeepSeek V4 Flash Vision (Experimental)",
            input: ["text", "image"],
            reasoning: true,
            contextWindow: 1000000,
            status: "preview",
            statusReason: "Experimental vision variant; snapshot-pinned experimental release.",
          },
          {
            id: "deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            input: ["text"],
            reasoning: true,
            contextWindow: 1000000,
          },
          {
            id: "deepseek-chat",
            name: "DeepSeek Chat",
            input: ["text"],
            contextWindow: 1000000,
            status: "deprecated",
            replacedBy: "deepseek-v4-flash",
          },
          {
            id: "deepseek-reasoner",
            name: "DeepSeek Reasoner",
            input: ["text"],
            reasoning: true,
            contextWindow: 1000000,
            status: "deprecated",
            // DeepSeek's deprecation notice maps reasoner → v4-flash (thinking
            // mode), not v4-pro. Flash already carries reasoning: true.
            replacedBy: "deepseek-v4-flash",
          },
        ],
      },
    },
    minimax: {
      id: "minimax",
      name: "MiniMax",
      plugin: {
        id: "minimax",
      },
      docs: "/providers/minimax",
      categories: ["cloud", "llm"],
      previewCatalog: {
        models: [
          {
            id: "MiniMax-M3",
            name: "MiniMax M3",
            input: ["text"],
            reasoning: true,
            contextWindow: 1000000,
          },
        ],
      },
    },
  },
} satisfies OpenClawProviderIndex;
