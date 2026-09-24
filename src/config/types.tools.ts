// Defines tool availability and allowlist configuration types.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { DoomLoopGuardConfig } from "../agents/doom-loop-guard.js";
import type { z } from "zod";
import type { ChatType } from "../channels/chat-type.js";
import type { SafeBinProfileFixture } from "../infra/exec-safe-bin-policy.js";
import type { AgentElevatedAllowFromConfig, SessionSendPolicyAction } from "./types.base.js";
import type { ConfiguredProviderRequest } from "./types.provider-request.js";
import type { SecretInput } from "./types.secrets.js";
import type {
  AgentEntrySchema,
  ToolsSchema,
  ToolPolicySchema,
} from "./zod-schema.agent-runtime.js";
type SchemaToolsConfig = NonNullable<z.input<typeof ToolsSchema>>;
type SchemaMediaConfig = NonNullable<SchemaToolsConfig["media"]>;
type SchemaAudioConfig = NonNullable<SchemaMediaConfig["audio"]>;

export type { MemorySearchConfig } from "./types.memory.js";

export type MediaUnderstandingScopeMatch = {
  /** Channel/provider id to match before running media or link understanding. */
  channel?: string;
  /** Direct/group classification from the channel runtime, when available. */
  chatType?: ChatType;
  /** Attachment or link key prefix used for narrow per-source routing. */
  keyPrefix?: string;
};

export type MediaUnderstandingScopeRule = {
  /** Policy applied when match criteria select this scope rule. */
  action: SessionSendPolicyAction;
  /** Optional match filter; omitted match behaves as a catch-all rule. */
  match?: MediaUnderstandingScopeMatch;
};

export type MediaUnderstandingScopeConfig = {
  /** Fallback action when no scope rule matches. */
  default?: SessionSendPolicyAction;
  /** Ordered allow/block rules; first matching rule wins. */
  rules?: MediaUnderstandingScopeRule[];
};

export type MediaUnderstandingCapability = "image" | "audio" | "video";

export type MediaUnderstandingAttachmentsConfig = NonNullable<SchemaAudioConfig["attachments"]>;

export type MediaUnderstandingModelConfig = Omit<
  NonNullable<NonNullable<SchemaMediaConfig["models"]>[number]>,
  "request"
> & { request?: ConfiguredProviderRequest };

export type MediaUnderstandingConfig = Omit<SchemaAudioConfig, "scope" | "request"> & {
  scope?: MediaUnderstandingScopeConfig;
  request?: ConfiguredProviderRequest;
  /** Ordered model list (fallbacks in order). */
  models?: MediaUnderstandingModelConfig[];
};

/** Per-capability defaults and policy. Models live only in tools.media.models. */
export type MediaUnderstandingCapabilityConfig = Omit<MediaUnderstandingConfig, "models">;

export type LinkModelConfig = NonNullable<
  NonNullable<NonNullable<SchemaToolsConfig["links"]>["models"]>[number]
>;

export type LinkToolsConfig = Omit<NonNullable<SchemaToolsConfig["links"]>, "scope"> & {
  scope?: MediaUnderstandingScopeConfig;
};

export type MediaToolsConfig = {
  /** Canonical model list for image/audio/video, selected by capability tags. */
  models?: MediaUnderstandingModelConfig[];
  /** Max concurrent media understanding runs. */
  concurrency?: number;
  asyncCompletion?: {
    /**
     * Deprecated compatibility flag. Async media generation completions stay
     * requester-session mediated so source delivery policy remains agent-owned.
     */
    directSend?: boolean;
  };
  image?: MediaUnderstandingCapabilityConfig;
  audio?: MediaUnderstandingCapabilityConfig;
  video?: MediaUnderstandingCapabilityConfig;
};

export type ToolProfileId = NonNullable<SchemaToolsConfig["profile"]>;

export type ToolLoopDetectionDetectorConfig = {
  /** Enable warning/blocking for repeated identical calls to the same tool/params. */
  genericRepeat?: boolean;
  /** Enable warning/blocking for known no-progress polling loops. */
  knownPollNoProgress?: boolean;
  /** Enable warning/blocking for no-progress ping-pong alternating patterns. */
  pingPong?: boolean;
};

export type ToolLoopPostCompactionGuardConfig = {
  /** How many attempts post-compaction the guard remains armed (default: 3). */
  windowSize?: number;
};

export type ToolLoopDetectionConfig = {
  /** Enable tool-loop protection (default: false). */
  enabled?: boolean;
  /** Maximum tool call history entries retained for loop detection (default: 30). */
  historySize?: number;
  /** Warning threshold before a warning-only loop classification (default: 10). */
  warningThreshold?: number;
  /** Block repeated calls to the same unavailable tool after this many misses (default: 10). */
  unknownToolThreshold?: number;
  /** Critical threshold for blocking repetitive loops (default: 20). */
  criticalThreshold?: number;
  /** Global no-progress breaker threshold (default: 30). */
  globalCircuitBreakerThreshold?: number;
  /** Detector toggles. */
  detectors?: ToolLoopDetectionDetectorConfig;
  /** Post-compaction loop guard: aborts when the agent repeats the same (tool, args, result) immediately after auto-compaction-retry. */
  postCompactionGuard?: ToolLoopPostCompactionGuardConfig;
  /** Doom loop guard: aborts when consecutive LLM/tool/network failures reach threshold. */
  doomLoopGuard?: DoomLoopGuardConfig;
};

export type ToolSearchConfig = NonNullable<SchemaToolsConfig["toolSearch"]>;

export type CodeModeConfig = NonNullable<SchemaToolsConfig["codeMode"]>;

export type SwarmConfig = NonNullable<SchemaToolsConfig["swarm"]>;

export type SessionsToolsVisibility = "self" | "tree" | "agent" | "all";

export type ToolAllowDenyPolicyConfig = NonNullable<z.input<typeof ToolPolicySchema>>;

export type ToolPolicyConfig = ToolAllowDenyPolicyConfig & {
  /** Built-in profile used as the base policy before allow/deny merges. */
  profile?: ToolProfileId;
};

export type GroupToolPolicyConfig = ToolAllowDenyPolicyConfig;

export const TOOLS_BY_SENDER_KEY_TYPES = ["channel", "id", "e164", "username", "name"] as const;
export type ToolsBySenderKeyType = (typeof TOOLS_BY_SENDER_KEY_TYPES)[number];

export function parseToolsBySenderTypedKey(
  rawKey: string,
): { type: ToolsBySenderKeyType; value: string } | undefined {
  const trimmed = rawKey.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  for (const type of TOOLS_BY_SENDER_KEY_TYPES) {
    const prefix = `${type}:`;
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    // Preserve the original value casing after the typed prefix; usernames and
    // display names can be case-sensitive in channel-specific matching code.
    return {
      type,
      value: trimmed.slice(prefix.length),
    };
  }
  return undefined;
}

/**
 * Per-sender overrides.
 *
 * Prefer explicit key prefixes:
 * - channel:<channelId>:<senderId>
 * - id:<senderId>
 * - e164:<phone>
 * - username:<handle>
 * - name:<display-name>
 * - * (wildcard)
 *
 * Legacy unprefixed keys are supported for backward compatibility and are matched as senderId only.
 */
export type GroupToolPolicyBySenderConfig = Record<string, GroupToolPolicyConfig>;

export type ExecToolConfig = Omit<NonNullable<SchemaToolsConfig["exec"]>, "safeBinProfiles"> & {
  /** Preserve readonly authoring fixtures accepted by the safe-bin policy owner. */
  safeBinProfiles?: Record<string, SafeBinProfileFixture>;
};

export type FsToolsConfig = NonNullable<SchemaToolsConfig["fs"]>;

export type SessionsSpawnToolsConfig = NonNullable<SchemaToolsConfig["sessions_spawn"]>;

export type GitHubToolIdentityConfig = NonNullable<SchemaToolsConfig["github"]>;

export type AgentToolsConfig = Omit<
  NonNullable<z.input<typeof AgentEntrySchema>["tools"]>,
  "toolsBySender" | "exec" | "elevated" | "loopDetection"
> & {
  toolsBySender?: GroupToolPolicyBySenderConfig;
  exec?: ExecToolConfig;
  elevated?: {
    enabled?: boolean;
    allowFrom?: AgentElevatedAllowFromConfig;
  };
  /** Runtime loop detection for repetitive/stuck tool-call patterns. */
  loopDetection?: ToolLoopDetectionConfig;
};

/**
 * Bash-command discipline rules (all on by default). Each `false` disables one
 * rule; `enabled: false` disables the whole guard. See bash-command-discipline.ts.
 */
export type BashDisciplineConfig = {
  enabled?: boolean;
  /** Block recursive/codebase grep|rg (redirect to ast-grep). */
  astGrep?: boolean;
  /** Block foreground dev/serve/watch/follow/large-sleep (require background). */
  background?: boolean;
  /** Block bare cat/sed/head/tail file reads (redirect to the read tool). */
  preferRead?: boolean;
  /** Block force-push, reset --hard, clean -fd. */
  git?: boolean;
};

export type ToolsConfig = Omit<
  SchemaToolsConfig,
  "toolsBySender" | "media" | "web" | "exec" | "elevated" | "links" | "loopDetection"
> & {
  toolsBySender?: GroupToolPolicyBySenderConfig;
  media?: MediaToolsConfig;
  exec?: ExecToolConfig;
  elevated?: AgentToolsConfig["elevated"];
  links?: LinkToolsConfig;
  /** Bash-command discipline guard (ast-grep/background/read/git rules). On by default. */
  bashDiscipline?: BashDisciplineConfig;
  /** Runtime loop detection for repetitive/stuck tool-call patterns. */
  loopDetection?: ToolLoopDetectionConfig;
  web?: {
    search?: {
      /** Enable managed web_search and optional Codex-native web search. */
      enabled?: boolean;
      /** Search provider id. */
      provider?: string;
      /** Shared API key slot used by providers that do not need nested config. */
      apiKey?: SecretInput;
      /** Default search results count (1-10). */
      maxResults?: number;
      /** Timeout in seconds for search requests. */
      timeoutSeconds?: number;
      /** Cache TTL in minutes for search results. */
      cacheTtlMinutes?: number;
      /** Optional native Codex web search for Codex-capable models. */
      openaiCodex?: {
        /** Enable native Codex web search for eligible models. */
        enabled?: boolean;
        /** Use cached or live external web access. Default: "cached". */
        mode?: "cached" | "live";
        /** Optional allowlist of domains passed to the native Codex tool. */
        allowedDomains?: string[];
        /** Optional Codex native search context size hint. */
        contextSize?: "low" | "medium" | "high";
        /** Optional approximate user location passed to the native Codex tool. */
        userLocation?: {
          country?: string;
          region?: string;
          city?: string;
          timezone?: string;
        };
      };
    } & Record<string, unknown>;
    /** X (formerly Twitter) search tool configuration using xAI Grok. */
    x_search?: {
      /** Enable X search tool (default: true when xAI auth is available via plugin config or XAI_API_KEY). */
      enabled?: boolean;
      /** Model id to use for X search. */
      model?: string;
      /** Keep inline citations in the xAI response payload when available. */
      inlineCitations?: boolean;
      /** Optional max search/tool turns for xAI to use internally. */
      maxTurns?: number;
      /** Timeout in seconds for X search requests. */
      timeoutSeconds?: number;
      /** Cache TTL in minutes for X search results. */
      cacheTtlMinutes?: number;
    };
    fetch?: NonNullable<SchemaToolsConfig["web"]>["fetch"];
  };
};

export type MessageToolsConfig = NonNullable<SchemaToolsConfig["message"]>;
