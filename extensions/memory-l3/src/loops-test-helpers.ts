import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { LlmCaller } from "./llm.js";

/**
 * Mulberry32 PRNG. Same shape as the Rust regression-test reference so loop
 * fixtures stay deterministic. Seed `0xC1AB_C0DE_2026_DA1A` matches the Rust
 * `tests/memory_loops.rs` corpus.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const RUST_REFERENCE_SEED = 0xc1ab_c0de & 0xffff_ffff;

export type Concept = {
  id: string;
  canonical: string;
  paraphrases: string[];
};

const TOPIC_VOCAB = [
  [
    "user_pref:morning_standups",
    "user prefers morning standups",
    "standup in the morning is best",
    "morning standups are non-negotiable",
    "no afternoon standups",
  ],
  [
    "user_pref:tabs",
    "user uses tabs not spaces",
    "tabs over spaces always",
    "indent with tabs",
    "tab indentation is the rule",
  ],
  [
    "user_pref:dark_mode",
    "user runs everything in dark mode",
    "dark mode only please",
    "no light theme",
    "always dark mode",
  ],
  [
    "team:timezone_pt",
    "team is in PT timezone",
    "all meetings in pacific time",
    "PT for everything",
    "default to pacific time",
  ],
  [
    "proj:codename_orca",
    "project codename is Orca",
    "internal name Orca",
    "project Orca",
    "Orca is the codename",
  ],
  [
    "constraint:no_python2",
    "no python 2 code allowed",
    "python 2 is banned",
    "do not write python2",
    "python 3 only",
  ],
  [
    "lang:rust_primary",
    "primary language is rust",
    "rust is the main stack",
    "everything in rust",
    "rust as the default",
  ],
  [
    "release:weekly_thursday",
    "release cadence is weekly thursday",
    "thursday weekly releases",
    "ship every thursday",
    "weekly cadence on thursday",
  ],
  [
    "secrets:in_1password",
    "secrets live in 1password",
    "1password vault for secrets",
    "all keys in 1password",
    "store secrets in 1password",
  ],
  [
    "dep:no_left_pad",
    "do not depend on left-pad",
    "left-pad is forbidden",
    "never add left-pad",
    "left-pad dependency banned",
  ],
] as const;

export function buildConceptCorpus(
  seed: number,
  conceptCount = 10,
  paraphrasesPerConcept = 4,
): Concept[] {
  const rng = mulberry32(seed);
  const indices = TOPIC_VOCAB.map((_, i) => i);
  // Deterministic Fisher-Yates shuffle so the seed controls concept selection.
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const vi = indices[i];
    const vj = indices[j];
    if (vi === undefined || vj === undefined) {
      continue;
    }
    indices[i] = vj;
    indices[j] = vi;
  }
  const out: Concept[] = [];
  for (let k = 0; k < Math.min(conceptCount, indices.length); k += 1) {
    const idx = indices[k];
    if (idx === undefined) {
      continue;
    }
    const row = TOPIC_VOCAB[idx];
    if (!row) {
      continue;
    }
    const [id, canonical, ...rest] = row;
    out.push({
      id,
      canonical,
      paraphrases: rest.slice(0, paraphrasesPerConcept),
    });
  }
  return out;
}

/**
 * Builds a deterministic LlmCaller that recognizes concept paraphrases in
 * the conversation transcript and emits one fact per concept (skipping any
 * concept whose dedupKey is already in <already-known>, simulating the
 * PROMPT_VERSION=2 prompt rule).
 */
export function createConceptStubCaller(
  concepts: ReadonlyArray<Concept>,
  importance = 0.7,
): LlmCaller {
  return async ({ userPrompt }) => {
    const alreadyKnown = parseAlreadyKnown(userPrompt);
    const transcript = parseConversationBlock(userPrompt).toLowerCase();
    const facts: Array<{ text: string; importance: number; dedupKey: string }> = [];
    const emitted = new Set<string>();
    for (const concept of concepts) {
      if (alreadyKnown.has(concept.id)) {
        continue;
      }
      if (emitted.has(concept.id)) {
        continue;
      }
      const allTexts = [concept.canonical, ...concept.paraphrases].map((s) => s.toLowerCase());
      if (allTexts.some((t) => transcript.includes(t))) {
        facts.push({ text: concept.canonical, importance, dedupKey: concept.id });
        emitted.add(concept.id);
      }
    }
    return JSON.stringify({ facts });
  };
}

function parseAlreadyKnown(prompt: string): Set<string> {
  const match = /<already-known>([\s\S]*?)<\/already-known>/.exec(prompt);
  const out = new Set<string>();
  if (!match) {
    return out;
  }
  for (const raw of (match[1] ?? "").split("\n")) {
    const cleaned = raw.replace(/^[\s\-•]+/, "").trim();
    if (cleaned.length > 0 && cleaned !== "(none)") {
      out.add(cleaned);
    }
  }
  return out;
}

function parseConversationBlock(prompt: string): string {
  const match = /<conversation>([\s\S]*?)<\/conversation>/.exec(prompt);
  return match?.[1] ?? prompt;
}

export function makeUserMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: 0 } as never;
}

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
