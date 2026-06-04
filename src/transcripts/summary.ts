import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getMemoryEmbeddingProvider } from "../plugins/memory-embedding-provider-runtime.js";
import type { MemoryEmbeddingProvider } from "../plugins/memory-embedding-providers.js";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";

export type TranscriptsSummary = {
  sessionId: string;
  title: string;
  generatedAt: string;
  overview: string;
  transcript: string[];
  decisions: string[];
  actionItems: string[];
  risks: string[];
  utteranceCount: number;
  // Embedding fields for semantic search
  embedding?: number[]; // embedding vector for semantic search
  embeddingModel?: string; // model used to generate embedding
  embeddingAt?: string; // ISO timestamp when embedding was generated
};

const ACTION_PATTERNS =
  /\b(todo|action|follow up|follow-up|assign|owner|next step|ship|fix|send|schedule)\b/i;
const DECISION_PATTERNS = /\b(decided|decision|we will|we'll|agreed|approved|go with|ship it)\b/i;
const RISK_PATTERNS =
  /\b(risk|blocked|blocker|concern|issue|problem|unknown|deadline|privacy|security)\b/i;

function firstSentences(utterances: TranscriptUtterance[], limit: number): string {
  const text = normalizeStringEntries(utterances.map((utterance) => utterance.text)).join(" ");
  const sentences = text.match(/[^.!?]+[.!?]?/g) ?? [];
  return normalizeStringEntries(sentences.slice(0, limit)).join(" ");
}

function collectMatches(utterances: TranscriptUtterance[], pattern: RegExp): string[] {
  return utterances
    .filter((utterance) => pattern.test(utterance.text))
    .map(formatSpeakerLine)
    .filter(Boolean)
    .slice(0, 12);
}

function formatSpeakerLine(utterance: TranscriptUtterance): string {
  const text = utterance.text.trim();
  if (!text) {
    return "";
  }
  const speaker = utterance.speaker?.label?.trim();
  return speaker ? `${speaker}: ${text}` : text;
}

function formatTranscript(utterances: TranscriptUtterance[]): string[] {
  return utterances.map(formatSpeakerLine).filter(Boolean);
}

export function summarizeTranscripts(params: {
  session: TranscriptSessionDescriptor;
  utterances: TranscriptUtterance[];
}): TranscriptsSummary {
  const title = params.session.title?.trim() || "Transcripts";
  const overview = firstSentences(params.utterances, 4) || "No transcript captured yet.";
  return {
    sessionId: params.session.sessionId,
    title,
    generatedAt: new Date().toISOString(),
    overview,
    transcript: formatTranscript(params.utterances),
    decisions: collectMatches(params.utterances, DECISION_PATTERNS),
    actionItems: collectMatches(params.utterances, ACTION_PATTERNS),
    risks: collectMatches(params.utterances, RISK_PATTERNS),
    utteranceCount: params.utterances.length,
  };
}

function renderList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None captured";
}

export function renderTranscriptsMarkdown(summary: TranscriptsSummary): string {
  const lines = [
    `# ${summary.title}`,
    "",
    `Generated: ${summary.generatedAt}`,
    `Session: ${summary.sessionId}`,
  ];

  // Add embedding metadata if present
  if (summary.embeddingModel) {
    lines.push(
      "",
      `Embedding: ${summary.embeddingModel}${summary.embeddingAt ? ` (generated: ${summary.embeddingAt})` : ""}`,
    );
  }

  lines.push(
    "",
    "## Overview",
    summary.overview,
    "",
    "## Transcript",
    renderList(summary.transcript),
    "",
    "## Decisions",
    renderList(summary.decisions),
    "",
    "## Action Items",
    renderList(summary.actionItems),
    "",
    "## Risks",
    renderList(summary.risks),
    "",
    `Transcript utterances: ${summary.utteranceCount}`,
  );

  return lines.join("\n");
}

/**
 * Generate embedding vector for a transcript summary.
 *
 * Builds an embedding text from the summary overview and structured fields,
 * then uses the configured memory embedding provider to generate a vector.
 *
 * @param params - Summary and config for embedding generation
 * @returns Embedding vector (number array)
 * @throws Error if no embedding provider is configured
 */
export async function generateSummaryEmbedding(params: {
  summary: TranscriptsSummary;
  cfg: OpenClawConfig;
}): Promise<number[]> {
  const { summary, cfg } = params;

  // Resolve embedding provider (defaults to OpenAI)
  const providerId = "openai";
  const adapter = getMemoryEmbeddingProvider(providerId, cfg);
  if (!adapter) {
    throw new Error(
      `No embedding provider configured for transcript summaries: ${providerId} not found`,
    );
  }

  // Build embedding text from summary + structured fields
  const embeddingText = buildEmbeddingTextFromSummary(summary);

  // Create provider instance with default model
  const createResult = await adapter.create({
    config: cfg,
    model: adapter.defaultModel || "text-embedding-3-small",
  });
  const provider = createResult.provider;
  if (!provider) {
    throw new Error(`Failed to create embedding provider instance: ${providerId}`);
  }

  // Generate embedding for the summary text
  const embeddings = await provider.embedBatch([embeddingText]);
  return embeddings[0];
}

/**
 * Build embedding text from summary components.
 *
 * Combines the overview with structured metadata (topics/decisions/action items)
 * to create a rich text representation for embedding generation.
 */
function buildEmbeddingTextFromSummary(summary: TranscriptsSummary): string {
  const parts: string[] = [];

  // Start with overview (main content)
  if (summary.overview) {
    parts.push(summary.overview);
  }

  // Add decisions as context
  if (summary.decisions.length > 0) {
    parts.push(`Decisions: ${summary.decisions.join("; ")}`);
  }

  // Add action items as context
  if (summary.actionItems.length > 0) {
    parts.push(`Action Items: ${summary.actionItems.join("; ")}`);
  }

  // Add risks as context
  if (summary.risks.length > 0) {
    parts.push(`Risks: ${summary.risks.join("; ")}`);
  }

  return parts.join("\n\n");
}
