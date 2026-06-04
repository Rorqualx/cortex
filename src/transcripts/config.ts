import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";

export type TranscriptsAutoStartConfig = {
  providerId: string;
  sessionId?: string;
  title?: string;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
};

export type ResolvedTranscriptsAutoStartConfig = {
  providerId: string;
  sessionId?: string;
  title?: string;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
};

export type TranscriptsConfig = {
  enabled?: boolean;
  maxUtterances?: number;
  autoStart?: TranscriptsAutoStartConfig[];
  embeddings?: {
    enabled?: boolean;
    model?: string;
  };
};

export type ResolvedTranscriptsConfig = {
  enabled: boolean;
  maxUtterances: number;
  autoStart: ResolvedTranscriptsAutoStartConfig[];
  embeddings: {
    enabled: boolean;
    model: string;
  };
};

function resolveAutoStart(raw: unknown): ResolvedTranscriptsAutoStartConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry): ResolvedTranscriptsAutoStartConfig | undefined => {
      const config = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const providerId = readString(config.providerId);
      if (!providerId) {
        return undefined;
      }
      return {
        providerId,
        sessionId: readString(config.sessionId),
        title: readString(config.title),
        accountId: readString(config.accountId),
        guildId: readString(config.guildId),
        channelId: readString(config.channelId),
        meetingUrl: readString(config.meetingUrl),
      };
    })
    .filter((entry): entry is ResolvedTranscriptsAutoStartConfig => entry !== undefined);
}

export function resolveTranscriptsConfig(raw: unknown): ResolvedTranscriptsConfig {
  const config = raw && typeof config === "object" ? (raw as Record<string, unknown>) : {};
  const maxUtterances =
    typeof config.maxUtterances === "number" && Number.isFinite(config.maxUtterances)
      ? Math.max(1, Math.min(10_000, Math.floor(config.maxUtterances)))
      : 2_000;

  // Resolve embeddings config
  const embeddingsConfig =
    config.embeddings && typeof config.embeddings === "object"
      ? (config.embeddings as Record<string, unknown>)
      : {};
  const embeddingsEnabled = embeddingsConfig.enabled === true;
  const embeddingModel = readString(embeddingsConfig.model) || "text-embedding-3-small";

  return {
    enabled: config.enabled === true,
    maxUtterances,
    autoStart: resolveAutoStart(config.autoStart),
    embeddings: {
      enabled: embeddingsEnabled,
      model: embeddingModel,
    },
  };
}
