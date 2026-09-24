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
            id: "deepseek-flash",
            name: "DeepSeek V4.1 Flash",
            input: ["text"],
            reasoning: true,
            contextWindow: 1000000,
          },
          {
            // Retired 2026-09: still validates on the API but is silently served
            // by DeepSeek-V4.1-Flash (deepseek-flash) at Flash pricing — the exact
            // silent-upgrade case the doctor reassignment table protects against.
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            input: ["text"],
            reasoning: true,
            contextWindow: 1000000,
            status: "deprecated",
            replacedBy: "deepseek-flash",
          },
          {
            // Experimental vision-input variant of V4 Flash. Capability-flagged
            // only — deliberately NOT added to delegation router defaults or
            // priority chains, so nothing auto-routes to an exp model.
            // Retired with the V4-Flash names: silently served by V4.1-Flash.
            // Nearest-capability survivor is deepseek-flash (no current
            // image-input successor in the lineup; image pins lose that modality).
            id: "deepseek-v4-flash-vision-exp",
            name: "DeepSeek V4 Flash Vision (Experimental)",
            input: ["text", "image"],
            reasoning: true,
            contextWindow: 1000000,
            status: "deprecated",
            statusReason:
              "Retired with the V4-Flash names; requests silently served by V4.1-Flash.",
            replacedBy: "deepseek-flash",
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
            replacedBy: "deepseek-flash",
          },
          {
            id: "deepseek-reasoner",
            name: "DeepSeek Reasoner",
            input: ["text"],
            reasoning: true,
            contextWindow: 1000000,
            status: "deprecated",
            // DeepSeek's deprecation notice maps reasoner → flash (thinking
            // mode). Flash carries reasoning: true; the v4-flash intermediate
            // name is itself retired now, so chain straight to deepseek-flash.
            replacedBy: "deepseek-flash",
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
