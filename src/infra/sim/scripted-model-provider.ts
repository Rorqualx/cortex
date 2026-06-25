import { AssistantMessageEventStream } from "../../../packages/llm-core/src/utils/event-stream.js";
import type {
  ApiProviderInternal,
  ApiStreamFunction,
  ApiStreamSimpleFunction,
} from "../../../packages/llm-runtime/src/api-registry.js";
/**
 * Scripted model provider — deterministic replay of recorded LLM streams.
 *
 * Implements the ApiProvider contract so it can be registered in the
 * llm-runtime api-registry in place of real providers during simulation.
 *
 * Two modes:
 *   - RECORD: wraps a real provider, captures every AssistantMessageEvent
 *             and the final AssistantMessage into a ModelScript.
 *   - REPLAY: reads a pre-recorded ModelScript and replays events
 *             token-by-token through a fresh AssistantMessageEventStream.
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
} from "../../llm/types.js";

/** Serialized record of one model call. */
export interface ModelScript {
  /** Hash key that uniquely identifies this (model, context) pair. */
  key: string;
  /** Chronological sequence of stream events (text_delta, toolcall_start, done, etc.). */
  events: AssistantMessageEvent[];
  /** Final resolved assistant message. */
  finalMessage: AssistantMessage;
  /** Provider that produced the original response. */
  provider: string;
  /** Model id that produced the original response. */
  modelId: string;
  /** API family. */
  api: Api;
}

/** In-memory script store keyed by script hash. */
export type ScriptStore = Map<string, ModelScript>;

export type ScriptedProviderMode = "record" | "replay";

/** Options for creating a scripted model provider. */
export interface ScriptedModelProviderOptions {
  mode: ScriptedProviderMode;
  /** Script store shared across all scripted providers. */
  scripts: ScriptStore;
  /** The real provider to wrap in RECORD mode. Required when mode === "record". */
  realProvider?: ApiProviderInternal;
}

/**
 * Computes a deterministic hash key for a given model+context pair.
 * Normalizes the context to avoid spurious mismatches from timestamps.
 */
export function computeScriptKey(model: Model, context: Context): string {
  const normalized = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    systemPrompt: context.systemPrompt,
    messages: context.messages.map((m) => ({
      role: m.role,
      // Strip timestamps from messages for stable hashing
      content:
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : c))
            : m.content,
    })),
    tools: context.tools?.map((t) => ({ name: t.name, description: t.description })),
  };
  const json = JSON.stringify(normalized);
  return djb2Hash(json);
}

/** Simple fast string hash (djb2). */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/** Creates a scripted stream function (full or simple). */
function createScriptedStreamFunction(
  mode: ScriptedProviderMode,
  scripts: ScriptStore,
  realStream: ApiStreamFunction | undefined,
): ApiStreamFunction {
  return (model: Model, context: Context, options?: StreamOptions) => {
    const key = computeScriptKey(model, context);

    if (mode === "replay") {
      const script = scripts.get(key);
      if (!script) {
        throw new Error(
          `ScriptedModelProvider: no script found for key "${key}" ` +
            `(model=${model.id}, api=${model.api}). ` +
            `Run in record mode first to capture the script.`,
        );
      }
      return replayScript(script);
    }

    // RECORD mode
    if (!realStream) {
      throw new Error("ScriptedModelProvider: realProvider is required in record mode.");
    }
    const realStreamResult = realStream(model, context, options);
    return recordStream(realStreamResult, key, scripts, model);
  };
}

/**
 * Replays a recorded script by pushing all captured events through a fresh
 * AssistantMessageEventStream. The final done/error event resolves result().
 */
export function replayScript(
  script: ModelScript,
): AssistantMessageEventStream & AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

  // Push events asynchronously so consumers can iterate via async iterator
  queueMicrotask(() => {
    for (const event of script.events) {
      stream.push(event);
    }
  });

  return stream;
}

/**
 * Wraps a real stream to capture every event and the final result into a script.
 */
export function recordStream(
  source: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> },
  key: string,
  scripts: ScriptStore,
  model: Model,
): AssistantMessageEventStream & AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const events: AssistantMessageEvent[] = [];

  void (async () => {
    try {
      for await (const event of source) {
        events.push(event);
        stream.push(event);
      }
      const finalMessage = await source.result();
      scripts.set(key, {
        key,
        events,
        finalMessage,
        provider: model.provider,
        modelId: model.id,
        api: model.api,
      });
    } catch (err) {
      // If the real stream errors, propagate the error through our stream
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorEvent: AssistantMessageEvent = {
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [{ type: "text", text: errorMessage }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage,
          timestamp: Date.now(),
        },
      };
      events.push(errorEvent);
      stream.push(errorEvent);
    }
  })();

  return stream;
}

/**
 * Builds a scripted ApiProvider for the given API.
 *
 * Usage:
 *   const scripted = createScriptedApiProvider("openai-completions", {
 *     mode: "replay",
 *     scripts: myScriptStore,
 *   });
 *   registerApiProvider(scripted);
 */
export function createScriptedApiProvider<TApi extends Api>(
  api: TApi,
  options: ScriptedModelProviderOptions,
): {
  api: TApi;
  stream: ApiStreamFunction;
  streamSimple: ApiStreamSimpleFunction;
} {
  return {
    api,
    stream: createScriptedStreamFunction(
      options.mode,
      options.scripts,
      options.realProvider?.stream,
    ),
    streamSimple: createScriptedStreamFunction(
      options.mode,
      options.scripts,
      options.realProvider?.streamSimple,
    ),
  };
}

/**
 * Wraps the entire provider registry so every registered provider is replaced
 * by a scripted version. In RECORD mode the real providers are preserved as
 * fallbacks; in REPLAY mode missing scripts throw.
 */
export function createUniversalScriptedProvider(
  options: Omit<ScriptedModelProviderOptions, "realProvider"> & {
    resolveRealProvider: (api: Api) => ApiProviderInternal | undefined;
  },
): {
  stream: ApiStreamFunction;
  streamSimple: ApiStreamSimpleFunction;
} {
  const { mode, scripts, resolveRealProvider } = options;
  const stream: ApiStreamFunction = (model, context, options_) => {
    const key = computeScriptKey(model, context);
    if (mode === "replay") {
      const script = scripts.get(key);
      if (!script) {
        throw new Error(
          `ScriptedModelProvider: no script found for key "${key}" ` +
            `(model=${model.id}, api=${model.api}).`,
        );
      }
      return replayScript(script);
    }
    const realProvider = resolveRealProvider(model.api);
    if (!realProvider) {
      throw new Error(
        `ScriptedModelProvider: no real provider registered for api "${model.api}" in record mode.`,
      );
    }
    const realStream = realProvider.stream(model, context, options_);
    return recordStream(realStream, key, scripts, model);
  };
  const streamSimple: ApiStreamSimpleFunction = (model, context, options_) => {
    const key = computeScriptKey(model, context);
    if (mode === "replay") {
      const script = scripts.get(key);
      if (!script) {
        throw new Error(
          `ScriptedModelProvider: no script found for key "${key}" ` +
            `(model=${model.id}, api=${model.api}).`,
        );
      }
      return replayScript(script);
    }
    const realProvider = resolveRealProvider(model.api);
    if (!realProvider) {
      throw new Error(
        `ScriptedModelProvider: no real provider registered for api "${model.api}" in record mode.`,
      );
    }
    const realStream = realProvider.streamSimple(model, context, options_);
    return recordStream(realStream, key, scripts, model);
  };
  return { stream, streamSimple };
}
