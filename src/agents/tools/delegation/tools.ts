// The 9 unified delegation tools, registered into the core agent toolset.
//
// One tool per KIND (code/review/research/delegate/explore/swarm/plan/academic/
// vision). The chat picks the kind; router.resolveRoute picks provider+model
// ("auto") unless the caller passes `provider`/`model`. Each tool runs through
// runDelegation, which executes across the provider fallback chain using the
// host model-fallback engine and host-resolved API keys.

import { Type } from "typebox";
import { getRuntimeConfig } from "../../../config/config.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveApiKeyForProvider } from "../../model-auth.js";
import {
  readStringArrayParam,
  readStringParam,
  textResult,
  ToolInputError,
  type AnyAgentTool,
} from "./../common.js";
import { runAcademicLoop } from "./academic-loop.js";
import { runExploreLoop } from "./explore-loop.js";
import type { HostAuthResolver } from "./host-config.js";
import { resolveRoute, type DelegationKind } from "./router.js";
import { runDelegation } from "./run-with-provider.js";
import { runSwarmV2Loop } from "./swarm-v2-loop.js";
import { SYSTEM_PROMPTS, type SystemPromptKey } from "./system-prompts.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 8000;
// OpenClaw config provider ids eligible for delegation overrides.
const VALID_PROVIDERS: readonly string[] = ["zai", "deepseek", "moonshot", "kimi"];

export type CreateDelegationToolsOptions = {
  config?: OpenClawConfig | undefined;
  agentDir?: string | undefined;
  workspaceDir?: string | undefined;
  agentSessionKey?: string | undefined;
};

/** Per-provider model set for the academic pipeline (plan/relevance vs synth/verify). */
function academicModels(providerId: string): {
  planModel: string;
  relevanceModel: string;
  synthesizeModel: string;
  verifyModel: string;
} {
  switch (providerId) {
    case "deepseek":
      return {
        planModel: "deepseek-v4-flash",
        relevanceModel: "deepseek-v4-flash",
        synthesizeModel: "deepseek-v4-pro",
        verifyModel: "deepseek-v4-pro",
      };
    case "moonshot":
      return {
        planModel: "kimi-k2.6",
        relevanceModel: "kimi-k2.6",
        synthesizeModel: "kimi-k2.6",
        verifyModel: "kimi-k2.6",
      };
    case "kimi":
      return {
        planModel: "kimi-for-coding",
        relevanceModel: "kimi-for-coding",
        synthesizeModel: "kimi-for-coding",
        verifyModel: "kimi-for-coding",
      };
    case "zai":
    default:
      return {
        planModel: "glm-4.6",
        relevanceModel: "glm-4.6",
        synthesizeModel: "glm-5.1",
        verifyModel: "glm-5.1",
      };
  }
}

/** Maps an explicit provider override (with glm/moonshot aliases) to a config id. */
function readProviderOverride(params: Record<string, unknown>): string | undefined {
  const raw = readStringParam(params, "provider");
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  const alias = lower === "glm" ? "zai" : lower;
  if (!VALID_PROVIDERS.includes(alias)) {
    throw new ToolInputError(
      `Unknown provider '${raw}'. Valid: ${VALID_PROVIDERS.join(", ")} (or 'glm' for zai).`,
    );
  }
  return alias;
}

/** Build the host key resolver for the active config/agent. */
function makeKeyResolver(
  cfg: OpenClawConfig | undefined,
  opts: CreateDelegationToolsOptions,
): HostAuthResolver {
  return async (providerId: string) => {
    const auth = await resolveApiKeyForProvider({
      provider: providerId,
      cfg,
      ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
      ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
      // kimi-for-coding speaks anthropic-messages; the rest are OpenAI-compat.
      modelApi: providerId === "kimi" ? "anthropic-messages" : "openai-completions",
    });
    return { apiKey: auth?.apiKey, mode: auth?.mode };
  };
}

// Shared parameter fragments reused across tool schemas.
const providerField = Type.Optional(
  Type.String({
    description:
      "Override provider: zai | deepseek | kimi (glm/moonshot aliases ok). Omit to auto-route.",
  }),
);
const modelField = Type.Optional(
  Type.String({
    description: "Override model id for the resolved provider. Omit to use the per-kind default.",
  }),
);
const thinkingField = Type.Optional(
  Type.Boolean({
    description:
      "Enable extended reasoning. Defaults true for analysis/loops, false for trivial lookups.",
  }),
);
const contextField = Type.Optional(
  Type.Array(Type.String(), { description: "Reference material excerpts already in hand." }),
);
const maxTokensField = Type.Optional(
  Type.Number({ description: `Max output tokens (default ${DEFAULT_MAX_OUTPUT_TOKENS}).` }),
);

type ExecCtx = {
  cfg: OpenClawConfig | undefined;
  resolveKey: HostAuthResolver;
  sessionKey: string | undefined;
};

/** Run a single-shot (one model call) kind via the fallback chain. */
async function runSingleShot(
  kind: DelegationKind,
  promptKey: SystemPromptKey,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  ctx: ExecCtx,
): Promise<AgentToolResultText> {
  const task = readStringParam(params, "task", { required: true })!;
  const contextItems = readStringArrayParam(params, "context");
  const images = readStringArrayParam(params, "images");
  const thinking = (params["thinking"] as boolean | undefined) ?? true;
  const maxOutputTokens =
    (params["max_output_tokens"] as number | undefined) ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const route = resolveRoute({
    kind,
    cfg: ctx.cfg,
    provider: readProviderOverride(params),
    model: readStringParam(params, "model"),
  });

  const { result, provider, model } = await runDelegation<string>({
    cfg: ctx.cfg,
    primary: route.primary,
    fallbacks: route.fallbacks,
    resolveApiKeyForProvider: ctx.resolveKey,
    sessionKey: ctx.sessionKey,
    abortSignal: signal,
    unusableReason: (content) =>
      content.trim().length === 0 ? "provider returned empty content" : undefined,
    run: async (client, modelId) => {
      const res = await client.call({
        systemPrompt: SYSTEM_PROMPTS[promptKey],
        userPrompt: task,
        contextItems,
        images,
        maxOutputTokens,
        thinking,
        format: "markdown",
        model: modelId,
      });
      return res.content;
    },
  });
  return textResult(result, { status: "ok", kind, provider, model });
}

type AgentToolResultText = ReturnType<typeof textResult>;

export function createDelegationTools(options?: CreateDelegationToolsOptions): AnyAgentTool[] {
  const opts = options ?? {};
  const cfg = opts.config ?? getRuntimeConfig();
  const resolveKey = makeKeyResolver(cfg, opts);
  const ctx: ExecCtx = { cfg, resolveKey, sessionKey: opts.agentSessionKey };

  const singleShot = (
    kind: DelegationKind,
    promptKey: SystemPromptKey,
    name: string,
    label: string,
    description: string,
    extraParams: Record<string, unknown> = {},
  ): AnyAgentTool => ({
    label,
    name,
    description,
    parameters: Type.Object({
      task: Type.String({ description: "The instruction / prompt." }),
      context: contextField,
      thinking: thinkingField,
      provider: providerField,
      model: modelField,
      max_output_tokens: maxTokensField,
      ...extraParams,
    }),
    execute: async (_toolCallId, args, signal) =>
      runSingleShot(kind, promptKey, args as Record<string, unknown>, signal, ctx),
  });

  const codeTool = singleShot(
    "code",
    "code",
    "delegate_code",
    "Delegate: Code",
    "Delegate code generation/modification to a fast coding model (auto-routed provider, with fallback). Pass the instruction as `task` and any reference excerpts as `context`.",
  );
  const reviewTool = singleShot(
    "review",
    "review",
    "delegate_review",
    "Delegate: Review",
    "Delegate a code/diff review (correctness, security, performance) to a reasoning model. Pass the diff/file as `task` or `context`.",
  );
  const researchTool = singleShot(
    "research",
    "research",
    "delegate_research",
    "Delegate: Research",
    "Read-and-synthesize-with-citations over material you supply in `context`. For fetch-and-synthesize use `delegate_explore` with web tools instead.",
  );
  const delegateTool = singleShot(
    "delegate",
    "delegate",
    "delegate_generic",
    "Delegate: Generic",
    "Generic delegation fallback — runs the task on an auto-routed model with provider fallback.",
  );
  const planTool = singleShot(
    "plan",
    "plan",
    "delegate_plan",
    "Delegate: Plan",
    "Decompose a task into an agentic step plan (defaults to Kimi K2.6, calibrated for step decomposition).",
  );
  const visionTool = singleShot(
    "vision",
    "vision",
    "delegate_vision",
    "Delegate: Vision",
    "Analyze image(s) and answer the task. Pass image URLs or data-URLs in `images`.",
    {
      images: Type.Optional(
        Type.Array(Type.String(), { description: "Image URLs or data-URLs to analyze." }),
      ),
    },
  );

  const exploreTool: AnyAgentTool = {
    label: "Delegate: Explore",
    name: "delegate_explore",
    description:
      "Explore a local codebase with a server-side ReAct loop (read-only fs/web tools by default). Returns a synthesis; the iteration trace stays internal. Pass `roots` (absolute paths; [] for inline).",
    parameters: Type.Object({
      task: Type.String({ description: "What to find/answer." }),
      roots: Type.Array(Type.String(), {
        description: "Absolute search roots. Use [] for inline (no fs) tasks.",
      }),
      context: contextField,
      thinking: thinkingField,
      provider: providerField,
      model: modelField,
      max_output_tokens: maxTokensField,
    }),
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true })!;
      const roots = readStringArrayParam(params, "roots") ?? [];
      const contextItems = readStringArrayParam(params, "context");
      const thinking = (params["thinking"] as boolean | undefined) ?? true;
      const maxOutputTokens =
        (params["max_output_tokens"] as number | undefined) ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const route = resolveRoute({
        kind: "explore",
        cfg,
        provider: readProviderOverride(params),
        model: readStringParam(params, "model"),
      });
      const { result, provider, model } = await runDelegation<string>({
        cfg,
        primary: route.primary,
        fallbacks: route.fallbacks,
        resolveApiKeyForProvider: resolveKey,
        sessionKey: ctx.sessionKey,
        abortSignal: signal,
        unusableReason: (c) =>
          c.trim().length === 0 ? "explore returned empty content" : undefined,
        run: async (client, modelId) => {
          const res = await runExploreLoop(client, {
            task,
            roots,
            contextItems,
            model: modelId,
            thinking,
            format: "markdown",
            maxOutputTokens,
          });
          return res.content;
        },
      });
      return textResult(result, { status: "ok", kind: "explore", provider, model });
    },
  };

  const swarmTool: AnyAgentTool = {
    label: "Delegate: Swarm",
    name: "delegate_swarm",
    description:
      "Run an iterative agent swarm (CEO orchestrator + recursive sub-agents) for wide enumeration or multi-round drilling. Pass `roots` (absolute; [] for inline) and the task.",
    parameters: Type.Object({
      task: Type.String({ description: "The decomposable task." }),
      roots: Type.Array(Type.String(), {
        description: "Absolute search roots. Use [] for inline tasks.",
      }),
      context: contextField,
      thinking: thinkingField,
      provider: providerField,
      model: modelField,
      max_output_tokens: maxTokensField,
    }),
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true })!;
      const roots = readStringArrayParam(params, "roots") ?? [];
      const contextItems = readStringArrayParam(params, "context");
      const thinking = (params["thinking"] as boolean | undefined) ?? true;
      const maxOutputTokens =
        (params["max_output_tokens"] as number | undefined) ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const route = resolveRoute({
        kind: "swarm",
        cfg,
        provider: readProviderOverride(params),
        model: readStringParam(params, "model"),
      });
      const { result, provider, model } = await runDelegation<string>({
        cfg,
        primary: route.primary,
        fallbacks: route.fallbacks,
        resolveApiKeyForProvider: resolveKey,
        sessionKey: ctx.sessionKey,
        abortSignal: signal,
        unusableReason: (c) => (c.trim().length === 0 ? "swarm returned empty content" : undefined),
        run: async (client, modelId) => {
          const res = await runSwarmV2Loop(client, {
            task,
            roots,
            contextItems,
            model: modelId,
            thinking,
            format: "markdown",
            maxOutputTokens,
          });
          return res.content;
        },
      });
      return textResult(result, { status: "ok", kind: "swarm", provider, model });
    },
  };

  const academicTool: AnyAgentTool = {
    label: "Delegate: Academic",
    name: "delegate_academic",
    description:
      "Academic deep-research with citation grounding (multi-source retrieval → synthesize → verify). Pass only the research question as `task`.",
    parameters: Type.Object({
      task: Type.String({ description: "The research question." }),
      provider: providerField,
      max_output_tokens: maxTokensField,
    }),
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const question = readStringParam(params, "task", { required: true })!;
      const route = resolveRoute({ kind: "academic", cfg, provider: readProviderOverride(params) });
      const { result, provider, model } = await runDelegation<string>({
        cfg,
        primary: route.primary,
        fallbacks: route.fallbacks,
        resolveApiKeyForProvider: resolveKey,
        sessionKey: ctx.sessionKey,
        abortSignal: signal,
        unusableReason: (c) =>
          c.trim().length === 0 ? "academic returned empty content" : undefined,
        run: async (client, _modelId, prov) => {
          const res = await runAcademicLoop({ question, client, ...academicModels(prov) });
          return res.markdown;
        },
      });
      return textResult(result, { status: "ok", kind: "academic", provider, model });
    },
  };

  return [
    codeTool,
    reviewTool,
    researchTool,
    delegateTool,
    planTool,
    visionTool,
    exploreTool,
    swarmTool,
    academicTool,
  ];
}
