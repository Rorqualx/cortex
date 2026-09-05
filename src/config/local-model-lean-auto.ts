import { isCloudModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "./types.openclaw.js";

const AUTO_LOCAL_MODEL_LEAN_PROVIDER_IDS = new Set(["lmstudio", "ollama"]);

/**
 * QW-4: Suggested models for constrained nodes (Pi, low-memory devices).
 * These are candidates the onboarding flow can surface when the user is
 * setting up a local model daemon on hardware that can't run full-size
 * models. All are available in GGUF/MLX/ONNX format for Ollama or LMStudio.
 *
 * The discovery pipeline probes the local daemon at runtime — this list
 * is a documentation hint, not a hard dependency.
 */
export const SUGGESTED_CONSTRAINED_NODE_MODELS = [
  {
    id: "LiquidAI/LFM2.5-2.6B",
    name: "LiquidAI LFM2.5 2.6B",
    footprint: "~2.5GB",
    contextWindow: 131072,
    notes:
      "Hybrid conv+attention architecture, agentic RL post-training. Good for Pi 5 / 8GB nodes.",
  },
] as const;

/** Returns true only for local runtimes that onboarding can identify without model-name guesses. */
function shouldAutoEnableLocalModelLean(
  config: OpenClawConfig,
  providerId: string,
  modelRef: string,
): boolean {
  const normalizedProviderId = normalizeProviderId(providerId);
  // A managed daemon can still serve a hosted model; source ownership wins.
  if (normalizedProviderId === "ollama" && isCloudModelRef(modelRef)) {
    return false;
  }
  return (
    AUTO_LOCAL_MODEL_LEAN_PROVIDER_IDS.has(normalizedProviderId) ||
    Boolean(
      findNormalizedProviderValue(config.models?.providers, normalizedProviderId)?.localService,
    )
  );
}

function resolveDefaultModelRef(config: OpenClawConfig): string | undefined {
  const model = config.agents?.defaults?.model;
  return typeof model === "string" ? model : model?.primary;
}

function clearAutoModel(config: OpenClawConfig): OpenClawConfig {
  const wizard = { ...config.wizard };
  delete wizard.localModelLeanAutoModel;
  return { ...config, wizard };
}

/** Maintains the onboarding-owned lean default while preserving explicit user configuration. */
export function applyAutoLocalModelLean(params: {
  config: OpenClawConfig;
  providerId: string;
  modelRef: string;
  previousModelRef?: string;
}): {
  config: OpenClawConfig;
  changed: boolean;
  enabled: boolean;
} {
  const localModelLean = params.config.agents?.defaults?.experimental?.localModelLean;
  const autoModel = params.config.wizard?.localModelLeanAutoModel;
  const onboardingOwnsSetting =
    autoModel !== undefined &&
    (params.previousModelRef ?? resolveDefaultModelRef(params.config)) === autoModel;
  if (!shouldAutoEnableLocalModelLean(params.config, params.providerId, params.modelRef)) {
    if (!autoModel) {
      return { config: params.config, changed: false, enabled: false };
    }
    const config = clearAutoModel(params.config);
    if (!onboardingOwnsSetting || localModelLean !== true) {
      return { config, changed: true, enabled: false };
    }
    const experimental = { ...params.config.agents?.defaults?.experimental };
    delete experimental.localModelLean;
    return {
      config: {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            experimental,
          },
        },
      },
      changed: true,
      enabled: false,
    };
  }
  if (localModelLean !== undefined) {
    if (!autoModel) {
      return { config: params.config, changed: false, enabled: false };
    }
    if (!onboardingOwnsSetting || !localModelLean) {
      return { config: clearAutoModel(params.config), changed: true, enabled: false };
    }
    if (autoModel === params.modelRef) {
      return { config: params.config, changed: false, enabled: false };
    }
    return {
      config: {
        ...params.config,
        wizard: { ...params.config.wizard, localModelLeanAutoModel: params.modelRef },
      },
      changed: true,
      enabled: false,
    };
  }
  return {
    config: {
      ...params.config,
      wizard: {
        ...params.config.wizard,
        localModelLeanAutoModel: params.modelRef,
      },
      agents: {
        ...params.config.agents,
        defaults: {
          ...params.config.agents?.defaults,
          experimental: {
            ...params.config.agents?.defaults?.experimental,
            localModelLean: true,
          },
        },
      },
    },
    changed: true,
    enabled: true,
  };
}
