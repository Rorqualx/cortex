/**
 * Cross-skill overlap screen at promotion (probe spike, ARCH-3 card 654cb681).
 * Advisory-only lexical overlap report between a staged candidate and the
 * promoted set — the gate's near-duplicate check (shingle ≥ 0.7, blocking)
 * covers exact body dups; this screen surfaces the 0.4–0.7 band plus
 * trigger/tool-shape collisions the gate never sees. Never gates promotion.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { toolShapeOverlap } from "./crossover.js";
import { shingles, shingleJaccard } from "./gate.js";
import { resolveSkillForgeSkillsRoot } from "./paths.js";

export const NEAR_DUP_BAND_MIN = 0.4;
export const TRIGGER_COLLISION_MIN = 0.45;
export const TOOL_SHAPE_COLLISION_MIN = 0.8;
export const SEMANTIC_NEAR_DUP_MIN = 0.85;
export const TOP_CONFLICTS_CAP = 5;
export const COMPOSITE_WEIGHTS = {
  shingle: 0.4,
  trigger: 0.25,
  tool: 0.25,
  embedding: 0.1,
} as const;

export type CrossSkillPair = {
  candidate: string;
  promoted: string;
  shingle: number;
  triggerOverlap: number;
  toolOverlap: number;
  embedding?: number;
  composite: number;
  flags: string[];
};

export type CrossSkillScreenResult = {
  pairs: CrossSkillPair[];
  topConflicts: string[];
};

type ContractSummary = {
  name: string;
  description: string;
  triggerTokens: string[];
  tools: string[];
  body: string;
};

/** Minimal stopword list — sharpens trigger-token Jaccard against prose filler
 *  (probe finding: raw description-token Jaccard dilutes to ~0.46 on realistic
 *  paraphrases; stopwords + name tokens recover the signal to ~0.56). */
const TRIGGER_STOPWORDS = new Set([
  "a", "an", "and", "the", "is", "are", "for", "of", "to", "on", "in",
  "with", "once", "after", "when", "that", "this", "it", "its", "by",
]);

/** Parse frontmatter fields + extract a lexical contract from a SKILL.md. */
export function parseSkillContract(content: string, fallbackName: string): ContractSummary {
  const match = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/u);
  const fm = match?.[1] ?? "";
  const body = match?.[2] ?? content;
  const name = /^name:\s*(.+)$/mu.exec(fm)?.[1]?.trim() ?? fallbackName;
  const description =
    /^description:\s*["']?([\s\S]*?)["']?\s*$/mu.exec(fm)?.[1]?.trim() ?? "";
  const triggerTokens = [
    ...(description.match(/[a-z0-9]+/giu) ?? []),
    ...(name.match(/[a-z0-9]+/giu) ?? []),
  ]
    .map((t) => t.toLowerCase())
    .filter((t) => !TRIGGER_STOPWORDS.has(t));
  // Tool refs: backticked tokens that look like tool ids (no path/prose punctuation).
  const tools = [
    ...new Set(
      (body.match(/`([^`]+)`/gu) ?? [])
        .map((t) => t.slice(1, -1).trim())
        .filter((t) => /^[a-z0-9][a-z0-9_-]{0,39}$/u.test(t)),
    ),
  ];
  return { name, description, triggerTokens, tools, body };
}

async function readSkillMd(skillMdPath: string): Promise<string | null> {
  try {
    return await fsp.readFile(skillMdPath, "utf8");
  } catch {
    return null;
  }
}

export async function crossSkillScreen(params: {
  skillDir: string;
  name: string;
  env?: NodeJS.ProcessEnv;
  embed?: (texts: string[]) => Promise<number[][]>;
}): Promise<CrossSkillScreenResult> {
  const env = params.env ?? process.env;
  const content = await readSkillMd(path.join(params.skillDir, "SKILL.md"));
  const pairs: CrossSkillPair[] = [];
  if (content === null) {
    return { pairs, topConflicts: [] };
  }
  const candidate = parseSkillContract(content, params.name);
  if (candidate.body.trim().length === 0) {
    return { pairs, topConflicts: [] };
  }
  let promotedRoot: string;
  try {
    promotedRoot = resolveSkillForgeSkillsRoot(env);
  } catch {
    return { pairs, topConflicts: [] };
  }
  let entries: string[];
  try {
    entries = await fsp.readdir(promotedRoot);
  } catch {
    return { pairs, topConflicts: [] };
  }

  const others = entries.filter((e) => !e.startsWith("_") && e !== params.name);
  const contracts: Array<{ entry: string; c: ContractSummary }> = [];
  for (const entry of others) {
    const raw = await readSkillMd(path.join(promotedRoot, entry, "SKILL.md"));
    if (raw === null || raw.trim().length === 0) {
      continue;
    }
    contracts.push({ entry, c: parseSkillContract(raw, entry) });
  }

  let embeddings: number[][] | undefined;
  if (params.embed && contracts.length > 0) {
    try {
      embeddings = await params.embed([
        `${candidate.name}: ${candidate.description}`,
        ...contracts.map(({ c }) => `${c.name}: ${c.description}`),
      ]);
    } catch {
      embeddings = undefined; // embedding lane is best-effort
    }
  }

  const candidateShingles = shingles(candidate.body);
  for (let i = 0; i < contracts.length; i++) {
    const { entry, c } = contracts[i];
    const shingle = shingleJaccard(candidateShingles, shingles(c.body));
    const triggerOverlap = toolShapeOverlap(candidate.triggerTokens, c.triggerTokens);
    const toolOverlap = toolShapeOverlap(candidate.tools, c.tools);
    const embedding = embeddings ? cosine(embeddings[0], embeddings[i + 1]) : undefined;
    const flags: string[] = [];
    if (shingle >= NEAR_DUP_BAND_MIN) flags.push("near-dup-band");
    if (triggerOverlap >= TRIGGER_COLLISION_MIN) flags.push("trigger-collision");
    if (toolOverlap >= TOOL_SHAPE_COLLISION_MIN) flags.push("tool-shape-collision");
    if (embedding !== undefined && embedding >= SEMANTIC_NEAR_DUP_MIN) {
      flags.push("semantic-near-dup");
    }
    const composite =
      COMPOSITE_WEIGHTS.shingle * shingle +
      COMPOSITE_WEIGHTS.trigger * triggerOverlap +
      COMPOSITE_WEIGHTS.tool * toolOverlap +
      (embedding !== undefined ? COMPOSITE_WEIGHTS.embedding * embedding : 0);
    pairs.push({
      candidate: candidate.name,
      promoted: entry,
      shingle: round(shingle),
      triggerOverlap: round(triggerOverlap),
      toolOverlap: round(toolOverlap),
      ...(embedding !== undefined ? { embedding: round(embedding) } : {}),
      composite: round(composite),
      flags,
    });
  }

  const topConflicts = pairs
    .filter((p) => p.flags.length > 0)
    .sort((a, b) => b.composite - a.composite)
    .slice(0, TOP_CONFLICTS_CAP)
    .map((p) => `${p.candidate} vs ${p.promoted} (${p.flags.join(",")})`);
  return { pairs, topConflicts };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}
