/**
 * OpenClaw native plugin wrapper for agentmcp.
 *
 * Registers delegation-only tools (code, review, research, delegate, academic,
 * vision, plan) as native plugin tools available to ALL session types
 * (main, sub-agent, cron isolated).
 *
 * Explore and swarm tools are NOT included here — they depend on Bun APIs
 * (Glob, Bun.spawn) and are available via the MCP server for the main session.
 * This covers the critical gap: cron research pipeline needs academic/research.
 *
 * Source: ~/Documents/Cline/code/agentmcp/
 */
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { callWithFallback, loadFallbackConfig, type FallbackResult } from "./lib/fallback.js";
import { resolveFilePaths, FilePathError } from "./lib/file-resolver.js";
import { estimateCostUsd, formatCostUsd } from "./lib/pricing.js";
import { makeProvider, readProviderConfig } from "./lib/providers/index.js";
import type { LlmCallResult, LlmClient, Provider } from "./lib/providers/types.js";
import { LlmError } from "./lib/providers/types.js";
import {
  makeCodeShape,
  makeReviewShape,
  makeResearchShape,
  makeDelegateShape,
  makeVisionShape,
  makeAcademicShape,
  type VisionProvider,
} from "./lib/schemas.js";
import { SYSTEM_PROMPTS } from "./lib/system-prompts.js";
import { DEFAULT_MODELS, SUPPORTED_TOOLS, describe, type ToolKind } from "./lib/tool-catalog.js";

// Dynamic import for academic-loop
let academicLoop: typeof import("./lib/academic-loop.js") | undefined;
async function getAcademicLoop() {
  academicLoop ??= await import("./lib/academic-loop.js");
  return academicLoop;
}

// Tool kinds that this plugin registers (NO explore/swarm — they need Bun Glob)
const PLUGIN_TOOLS: ToolKind[] = ["code", "review", "research", "delegate", "vision", "academic"];

const PROVIDERS: readonly Provider[] = ["zai", "deepseek", "kimi"];

type ToolFormat = "text" | "json" | "markdown";

function reasoningFloor(model: string, thinking: boolean, requested: number): number {
  const isK2Thinking = /^kimi-k2\.\d/.test(model) && thinking;
  return Math.max(requested, isK2Thinking ? 6000 : 3000);
}

function metaLine(
  toolName: string,
  result: LlmCallResult,
  thinking: boolean,
  provider: Provider,
): string {
  const thinkingTag = thinking ? "thinking:on" : "thinking:off";
  const cost = formatCostUsd(
    estimateCostUsd(
      provider,
      result.model,
      result.inputTokens,
      result.outputTokens,
      result.cacheHitTokens,
    ),
  );
  const costTag = cost ? ` · ${cost}` : "";
  const cacheTag =
    result.cacheHitTokens !== undefined && result.cacheHitTokens > 0
      ? ` · cache:hit/miss=${result.cacheHitTokens}/${result.cacheMissTokens ?? Math.max(0, result.inputTokens - result.cacheHitTokens)}`
      : "";
  return `\n\n---\n_model: ${toolName} (${result.model}·${thinkingTag}) · in:${result.inputTokens}t · out:${result.outputTokens}t${cacheTag} · ${result.latencyMs}ms${costTag}_`;
}

function errorHint(provider: Provider, status: number | undefined, model: string): string {
  if (status === 401 || status === 403) {
    const env = provider === "zai" ? "ZAI_API_KEY" : `${provider.toUpperCase()}_API_KEY`;
    return `\nFix: check ${env}.`;
  }
  if (status === 404) return `\nFix: model '${model}' may not be enabled.`;
  if (status === 429) return "\nFix: rate-limited.";
  return "";
}

function formatLlmError(err: LlmError, model: string): string {
  let msg = `[${err.provider} error] ${err.message}`;
  if (err.status) msg += ` (HTTP ${err.status})`;
  if (err.body) msg += `\nBody: ${err.body}`;
  msg += errorHint(err.provider, err.status, model);
  return msg;
}

// --- Delegation runner ---

interface RunInput {
  client: LlmClient;
  provider: Provider;
  toolName: string;
  systemPrompt: string;
  userPrompt: string;
  context: string[] | undefined;
  filePaths?: string[] | undefined;
  images?: string[] | undefined;
  format: ToolFormat;
  maxOutputTokens: number;
  model: string;
  thinking: boolean;
  temperatureOverride: number | undefined;
  /** All available clients for fallback. If set, fallback is enabled. */
  allClients?: Record<Provider, LlmClient | undefined>;
  fallbackConfig?: ReturnType<typeof loadFallbackConfig>;
}

function formatFallbackMeta(fb: FallbackResult, toolName: string, thinking: boolean): string {
  const primary = fb.attempts[0];
  const lines = fb.attempts.map((a) => {
    const status = a.error ? `error: ${a.error}` : "success";
    return `  ${a.provider}: ${status} (${a.latencyMs}ms)`;
  });
  const fallbackTag = fb.attempts.length > 1 ? ` · fallback:${fb.provider}` : "";
  return `\n\n---\n_model: ${toolName} (${fb.result.model}·thinking=${thinking}) · in:${fb.result.inputTokens}t · out:${fb.result.outputTokens}t · ${fb.result.latencyMs}ms${fallbackTag}_\n_attempts:\n${lines.join("\n")}`;
}

async function runDelegation(input: RunInput): Promise<any> {
  let resolvedFiles: string[];
  try {
    resolvedFiles = await resolveFilePaths(input.filePaths);
  } catch (err) {
    if (err instanceof FilePathError) {
      return {
        content: [{ type: "text", text: `[${input.provider} error] ${err.userMessage}` }],
        isError: true,
      };
    }
    throw err;
  }
  const mergedContext =
    resolvedFiles.length > 0 ? [...resolvedFiles, ...(input.context ?? [])] : input.context;

  const callParams = {
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    contextItems: mergedContext,
    images: input.images,
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperatureOverride,
    thinking: input.thinking,
    format: input.format,
    model: input.model,
  };

  try {
    let result: import("./lib/providers/types.js").LlmCallResult;
    let usedProvider = input.provider;
    let fallbackMeta = "";

    // Use fallback if multiple clients are available
    if (input.allClients && input.fallbackConfig) {
      const fb = await callWithFallback(
        input.allClients,
        input.fallbackConfig,
        input.provider,
        callParams,
      );
      result = fb.result;
      usedProvider = fb.provider;
      fallbackMeta = formatFallbackMeta(fb, input.toolName, input.thinking);
    } else {
      result = await input.client.call(callParams);
      fallbackMeta = metaLine(input.toolName, result, input.thinking, usedProvider);
    }

    if (input.format === "json") {
      const json: Record<string, unknown> = {
        tool: input.toolName,
        provider: usedProvider,
        content: result.content,
        model: result.model,
        thinking: input.thinking,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        latency_ms: result.latencyMs,
      };
      if (result.cacheHitTokens !== undefined) json.cache_hit_tokens = result.cacheHitTokens;
      if (result.cacheMissTokens !== undefined) json.cache_miss_tokens = result.cacheMissTokens;
      if (result.reasoningContent) json.reasoning_content = result.reasoningContent;
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    }
    return {
      content: [
        {
          type: "text",
          text: result.content + fallbackMeta,
        },
      ],
    };
  } catch (err) {
    if (err instanceof LlmError) {
      return { content: [{ type: "text", text: formatLlmError(err, input.model) }], isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `[${input.provider} error] ${msg}` }], isError: true };
  }
}

// --- Tool creation ---

const SHAPE_FACTORIES: Record<string, (p?: string) => any> = {
  code: () => makeCodeShape("zai" as Provider),
  review: () => makeReviewShape("zai" as Provider),
  research: () => makeResearchShape("zai" as Provider),
  delegate: () => makeDelegateShape("zai" as Provider),
  vision: (p) => makeVisionShape(p as VisionProvider),
  academic: () => makeAcademicShape("zai" as Provider),
};

/** Convert a Zod shape object (record of ZodType) to a JSON Schema object. */
function shapeToJsonSchema(shape: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const schema = z.object(shape);
  return schema.toJSONSchema() as Record<string, unknown>;
}

interface ToolCreationInput {
  provider: Provider;
  kind: ToolKind;
  client: LlmClient;
  allClients?: Record<Provider, LlmClient | undefined>;
  fallbackConfig?: ReturnType<typeof loadFallbackConfig>;
}

function createTool(input: ToolCreationInput): AnyAgentTool {
  const { provider, kind, client, allClients, fallbackConfig } = input;
  const toolName = `agentmcp__${provider}__${kind}`;
  const rawShape = kind === "vision" ? SHAPE_FACTORIES[kind](provider) : SHAPE_FACTORIES[kind]();
  const parameters = shapeToJsonSchema(rawShape);

  const handler = async (_id: string, rawParams: unknown, _signal?: AbortSignal): Promise<any> => {
    const args = rawParams as any;
    const model =
      args.model ?? (DEFAULT_MODELS[provider] as any)[kind] ?? DEFAULT_MODELS[provider].delegate;
    const format: ToolFormat = args.format ?? "text";
    const maxOutputTokens = args.max_output_tokens ?? 8000;
    const thinking = args.thinking ?? false;
    const temperature = args.temperature;

    // Academic tool — special pipeline
    if (kind === "academic") {
      try {
        const { runAcademicLoop } = await getAcademicLoop();
        const { markdown, stats } = await runAcademicLoop({
          question: args.question,
          client,
          planModel: "glm-4.7",
          relevanceModel: "glm-4.7",
          synthesizeModel: model,
          verifyModel: "glm-4.7",
        });
        return {
          content: [
            {
              type: "text",
              text:
                markdown +
                `\n\n---\n_academic: ${toolName} · ${stats.citationsTotal} cite · ${(stats.runtimeMs / 1000).toFixed(1)}s_`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `[${provider} error] ${msg}` }], isError: true };
      }
    }

    // Simple delegation tools (code, review, research, delegate, vision)
    let prefix = "";
    if (kind === "code" && args.language) prefix = `Language: ${args.language}\n\n`;
    if (kind === "review" && args.focus?.length > 0) prefix = `Focus: ${args.focus.join(", ")}\n\n`;
    if (kind === "research") prefix = `Citation style: ${args.cite_format ?? "inline"}\n\n`;

    const effectiveMax = ["review", "research"].includes(kind)
      ? reasoningFloor(model, thinking, maxOutputTokens)
      : maxOutputTokens;

    return runDelegation({
      client,
      provider,
      toolName,
      systemPrompt: (SYSTEM_PROMPTS as any)[kind] ?? SYSTEM_PROMPTS.delegate,
      userPrompt: prefix + args.task,
      context: args.context,
      filePaths: args.file_paths,
      images: args.images,
      format,
      maxOutputTokens: effectiveMax,
      model,
      thinking,
      temperatureOverride: temperature,
      allClients,
      fallbackConfig,
    });
  };

  return {
    label: `${provider} ${kind}`,
    name: toolName,
    description: describe(provider, kind),
    parameters,
    execute: handler,
  };
}

// --- Plugin entry ---

export default definePluginEntry({
  id: "agentmcp",
  name: "AgentMCP",
  description:
    "Multi-provider LLM delegation tools (code, review, research, delegate, academic, vision) for GLM, DeepSeek, and Kimi. Available to all session types including sub-agents and cron.",
  reload: {
    restartPrefixes: [
      "plugins.enabled",
      "plugins.allow",
      "plugins.deny",
      "plugins.entries.agentmcp",
    ],
  },
  register(api) {
    const ENV_PREFIX: Record<Provider, string> = { zai: "ZAI", deepseek: "DEEPSEEK", kimi: "KIMI" };
    const DEFAULT_BASES: Record<Provider, string> = {
      zai: "https://api.z.ai/api/coding/paas/v4",
      deepseek: "https://api.deepseek.com/v1",
      kimi: "https://api.moonshot.ai/v1",
    };
    const logger = api.logger;
    // The new plugin SDK (2026.6+) does not inject .config on the api object.
    // Resolve plugin config from the global openclaw config file instead.
    let pluginConfig: Record<string, any> = {};
    try {
      const fs = require("fs");
      const path = require("path");
      const os = require("os");
      const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      pluginConfig = raw?.plugins?.entries?.agentmcp?.config ?? {};
    } catch {
      // Fall through — env vars still work
    }

    // Provider key resolution: plugin config → env var
    function getKey(provider: Provider): string | undefined {
      const prefix = ENV_PREFIX[provider];
      const configKey =
        pluginConfig[`${prefix.toLowerCase()}ApiKey`] ?? pluginConfig[`${prefix}ApiKey`];
      return configKey || process.env[`${prefix}_API_KEY`];
    }

    const clients: Partial<Record<Provider, LlmClient>> = {};
    const skipped: Provider[] = [];

    for (const provider of PROVIDERS) {
      const apiKey = getKey(provider);
      if (!apiKey || apiKey.trim() === "") {
        skipped.push(provider);
        continue;
      }
      const prefix = ENV_PREFIX[provider];
      const baseUrl =
        pluginConfig[`${prefix.toLowerCase()}BaseUrl`] ??
        process.env[`${prefix}_BASE_URL`] ??
        DEFAULT_BASES[provider];
      clients[provider] = makeProvider(provider, { apiKey, baseUrl });
    }

    const availableCount = Object.keys(clients).length;
    if (availableCount === 0) {
      logger.error("agentmcp: No provider keys found.");
      return;
    }

    const fallbackConfig = loadFallbackConfig();
    const enableFallback = process.env["AGENTMCP_FALLBACK_DISABLE"] !== "1";

    let registered = 0;
    for (const provider of PROVIDERS) {
      const client = clients[provider];
      if (!client) continue;

      const supportedKinds = SUPPORTED_TOOLS[provider] as ToolKind[];
      for (const kind of PLUGIN_TOOLS) {
        if (!supportedKinds.includes(kind)) continue;
        api.registerTool(() =>
          createTool({
            provider,
            kind,
            client,
            allClients: enableFallback ? clients : undefined,
            fallbackConfig: enableFallback ? fallbackConfig : undefined,
          }),
        );
        registered++;
      }
    }

    const fallbackInfo = enableFallback
      ? ` · fallback chain: ${fallbackConfig.chain.join(" → ")}`
      : " · fallback disabled";
    logger.info(
      `agentmcp: Registered ${registered} native tools across ${availableCount} provider(s)` +
        (skipped.length > 0 ? ` (skipped: ${skipped.join(", ")})` : "") +
        fallbackInfo +
        ". Explore/swarm available via MCP server in main session.",
    );
  },
});
