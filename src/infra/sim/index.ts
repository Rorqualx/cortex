/**
 * Deterministic Simulation Testing (DST) infrastructure for OpenClaw.
 *
 * Exports:
 *   - SimulationEnv: clock + RNG injection surface
 *   - ScriptedModelProvider: deterministic replay of model response streams
 *   - RecordReplayHarness: capture real model I/O, replay deterministically
 */
export {
  createDefaultSimulationEnv,
  createDeterministicSimulationEnv,
  getSimulationEnv,
  setSimulationEnv,
  withSimulationEnv,
  withSimulationEnvAsync,
  type SimulationEnv,
  type SimulationEnvWithModel,
  type ScriptedModelProvider,
} from "./simulation-env.js";

export {
  computeScriptKey,
  createScriptedApiProvider,
  createUniversalScriptedProvider,
  recordStream,
  replayScript,
  type ModelScript,
  type ScriptStore,
  type ScriptedModelProviderOptions,
  type ScriptedProviderMode,
} from "./scripted-model-provider.js";

export {
  createModelRecorder,
  createModelReplayer,
  deserializeScripts,
  recordThenReplay,
  serializeScripts,
  type RecordReplayOptions,
  type RecordResult,
} from "./record-replay.js";
