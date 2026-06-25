/**
 * Record-replay harness for deterministic model I/O simulation.
 *
 * Usage:
 *   // 1. Record a real run
 *   const scripts = new Map<string, ModelScript>();
 *   const recorder = createModelRecorder({ scripts });
 *   await recorder.run(async () => {
 *     // ... any code that calls stream()/streamSimple()
 *   });
 *   const snapshot = serializeScripts(scripts);
 *   await fs.writeFile("scripts.json", snapshot);
 *
 *   // 2. Replay deterministically
 *   const loaded = deserializeScripts(await fs.readFile("scripts.json", "utf8"));
 *   const player = createModelReplayer({ scripts: loaded });
 *   await player.run(async () => {
 *     // ... same code path, now produces identical events
 *   });
 */
import {
  getApiProvider,
  getApiProviders,
  registerApiProvider,
  unregisterApiProviders,
  type ApiProviderInternal,
} from "../../../packages/llm-runtime/src/api-registry.js";
import type {
  Api,
  AssistantMessageEvent,
  ModelScript,
  ScriptStore,
} from "./scripted-model-provider.js";
import {
  createScriptedApiProvider,
  createUniversalScriptedProvider,
} from "./scripted-model-provider.js";

/** Options for the record-replay harness. */
export interface RecordReplayOptions {
  /** In-memory script store. Persist externally between record and replay. */
  scripts: ScriptStore;
  /**
   * When true, use a single universal provider that intercepts all APIs.
   * When false, replace each API provider individually (more precise but
   * requires knowing which APIs will be used).
   */
  universal?: boolean;
}

/** Result of a recording session. */
export interface RecordResult<T = unknown> {
  /** The original return value from the recorded run. */
  result: T;
  /** Scripts captured during the run. */
  scripts: ScriptStore;
  /** Number of unique model calls recorded. */
  recordedCalls: number;
}

/** Serializes a ScriptStore to a JSON string. */
export function serializeScripts(scripts: ScriptStore): string {
  const entries = Array.from(scripts.entries());
  return JSON.stringify(entries, null, 2);
}

/** Deserializes a ScriptStore from a JSON string. */
export function deserializeScripts(json: string): ScriptStore {
  const parsed = JSON.parse(json) as [string, ModelScript][];
  return new Map(parsed);
}

/**
 * Creates a recorder that swaps real providers for scripted wrappers.
 * During the run, every model call is forwarded to the real provider
 * and its events are captured into the script store.
 */
export function createModelRecorder(options: RecordReplayOptions) {
  const { scripts, universal = true } = options;
  const originalProviders = new Map<string, ApiProviderInternal>();

  function captureOriginals(): void {
    for (const p of getApiProviders()) {
      originalProviders.set(p.api, p);
    }
  }

  function installRecorders(): void {
    if (universal) {
      const scripted = createUniversalScriptedProvider({
        mode: "record",
        scripts,
        resolveRealProvider: (api) => originalProviders.get(api) ?? getApiProvider(api),
      });
      // Register a catch-all scripted provider for every known API.
      // We replace each existing provider with a scripted wrapper.
      for (const [api, real] of originalProviders) {
        registerApiProvider(
          {
            api: api as Api,
            stream: (model, context, opts) => scripted.stream(model, context, opts),
            streamSimple: (model, context, opts) => scripted.streamSimple(model, context, opts),
          },
          "sim:recorder",
        );
      }
    } else {
      for (const [api, real] of originalProviders) {
        registerApiProvider(
          createScriptedApiProvider(api as Api, {
            mode: "record",
            scripts,
            realProvider: real,
          }),
          "sim:recorder",
        );
      }
    }
  }

  function uninstallRecorders(): void {
    unregisterApiProviders("sim:recorder");
    // Restore original providers that were overwritten
    for (const [api, provider] of originalProviders) {
      if (!getApiProvider(api)) {
        registerApiProvider({
          api: api as Api,
          stream: provider.stream,
          streamSimple: provider.streamSimple,
        });
      }
    }
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<RecordResult<T>> {
      captureOriginals();
      installRecorders();
      try {
        const result = await fn();
        return {
          result,
          scripts,
          recordedCalls: scripts.size,
        };
      } finally {
        uninstallRecorders();
      }
    },
  };
}

/**
 * Creates a replayer that swaps real providers for scripted replay wrappers.
 * During the run, every model call looks up its pre-recorded script and
 * replays the exact same event sequence deterministically.
 */
export function createModelReplayer(options: RecordReplayOptions) {
  const { scripts, universal = true } = options;
  const originalProviders = new Map<string, ApiProviderInternal>();

  function captureOriginals(): void {
    for (const p of getApiProviders()) {
      originalProviders.set(p.api, p);
    }
  }

  function installReplayers(): void {
    if (universal) {
      const scripted = createUniversalScriptedProvider({
        mode: "replay",
        scripts,
        resolveRealProvider: (api) => originalProviders.get(api) ?? getApiProvider(api),
      });
      for (const [api] of originalProviders) {
        registerApiProvider(
          {
            api: api as Api,
            stream: (model, context, opts) => scripted.stream(model, context, opts),
            streamSimple: (model, context, opts) => scripted.streamSimple(model, context, opts),
          },
          "sim:replayer",
        );
      }
    } else {
      for (const [api] of originalProviders) {
        registerApiProvider(
          createScriptedApiProvider(api as Api, {
            mode: "replay",
            scripts,
          }),
          "sim:replayer",
        );
      }
    }
  }

  function uninstallReplayers(): void {
    unregisterApiProviders("sim:replayer");
    // Restore original providers that were overwritten
    for (const [api, provider] of originalProviders) {
      if (!getApiProvider(api)) {
        registerApiProvider({
          api: api as Api,
          stream: provider.stream,
          streamSimple: provider.streamSimple,
        });
      }
    }
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      captureOriginals();
      installReplayers();
      try {
        return await fn();
      } finally {
        uninstallReplayers();
      }
    },
  };
}

/**
 * Convenience: record once, then replay with the same seed.
 * Returns both the recorded scripts and the replay result.
 */
export async function recordThenReplay<T>(params: {
  seed: string;
  run: () => Promise<T>;
}): Promise<{ scripts: ScriptStore; recordResult: RecordResult<T>; replayResult: T }> {
  const scripts = new Map<string, ModelScript>();
  const recorder = createModelRecorder({ scripts });
  const recordResult = await recorder.run(params.run);
  const replayer = createModelReplayer({ scripts });
  const replayResult = await replayer.run(params.run);
  return { scripts, recordResult, replayResult };
}
