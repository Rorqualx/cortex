import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { TrajectoryEvent } from "../trajectory/types.js";
import { resolveSkillForgeCandidatesDir } from "./paths.js";

export const REPETITION_THRESHOLD = 3;
export const ERROR_RECOVERY_LOOKAHEAD = 10;

export const EXPLICIT_INSTRUCTION_PHRASES = [
  "/skills create",
  "/skill create",
  "turn this into a skill",
  "make this a skill",
  "save this as a skill",
  "remember this workflow",
  "crystallize this workflow",
] as const;

export const EMBEDDING_LANE_TODO =
  "Phase 2 embedding/semantic clustering lane requires an external embedding provider; pick one before implementing.";

export type RepetitionCandidate = {
  lane: "tool-shape";
  candidateId: string;
  toolShapeHash: string;
  toolSequence: string[];
  captureDirs: string[];
  occurrences: number;
  successScore: number;
  processVsOutcome?: ProcessVsOutcomeRubric;
};

export type ErrorRecoveryCandidate = {
  lane: "error-recovery";
  candidateId: string;
  captureDir: string;
  toolSequence: string[];
  failingTool: string;
  recoveringTool: string;
  rationale: string;
  successScore: number;
  processVsOutcome?: ProcessVsOutcomeRubric;
};

export type ExplicitCandidate = {
  lane: "explicit";
  candidateId: string;
  captureDir: string;
  toolSequence: string[];
  matchedPhrase: string;
  promptExcerpt: string;
  rationale: string;
  successScore: number;
  processVsOutcome?: ProcessVsOutcomeRubric;
};

export type Candidate = RepetitionCandidate | ErrorRecoveryCandidate | ExplicitCandidate;

function shortHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export async function readCaptureEvents(captureDir: string): Promise<TrajectoryEvent[]> {
  const file = path.join(captureDir, "events.jsonl");
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return [];
  }
  const events: TrajectoryEvent[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as TrajectoryEvent);
    } catch {
      // Skip malformed lines; the bundle writer guarantees JSON per line, but be defensive.
    }
  }
  return events;
}

export function extractToolSequence(events: TrajectoryEvent[]): string[] {
  const result: string[] = [];
  for (const event of events) {
    if (event.type !== "tool.call") {
      continue;
    }
    const name = event.data?.name;
    if (typeof name === "string" && name.length > 0) {
      result.push(name);
    }
  }
  return result;
}

export function hashToolSequence(sequence: string[]): string {
  return shortHash(sequence.join("\n"));
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

function extractUserMessageTexts(events: TrajectoryEvent[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (event.type !== "user.message") {
      continue;
    }
    const message = event.data?.message;
    if (!message || typeof message !== "object") {
      continue;
    }
    const text = extractContentText((message as { content?: unknown }).content);
    if (text.length > 0) {
      texts.push(text);
    }
  }
  return texts;
}

function isToolErrorResult(event: TrajectoryEvent): boolean {
  if (event.type !== "tool.result") {
    return false;
  }
  const message = event.data?.message;
  if (!message || typeof message !== "object") {
    return false;
  }
  if ((message as { isError?: unknown }).isError === true) {
    return true;
  }
  const text = extractContentText((message as { content?: unknown }).content);
  return /\b(error|failed|exception|traceback)\b/iu.test(text);
}

function findPrecedingToolCallName(events: TrajectoryEvent[], beforeIndex: number): string | null {
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && event.type === "tool.call") {
      const name = event.data?.name;
      return typeof name === "string" && name.length > 0 ? name : null;
    }
  }
  return null;
}

export type ErrorRecoveryMotif = {
  failingTool: string;
  recoveringTool: string;
  recoverySequence: string[];
};

export function detectErrorRecovery(events: TrajectoryEvent[]): ErrorRecoveryMotif[] {
  const motifs: ErrorRecoveryMotif[] = [];
  for (let i = 0; i < events.length; i += 1) {
    if (!isToolErrorResult(events[i])) {
      continue;
    }
    const failingTool = findPrecedingToolCallName(events, i);
    if (!failingTool) {
      continue;
    }
    const lookaheadEnd = Math.min(events.length, i + 1 + ERROR_RECOVERY_LOOKAHEAD);
    const recoveryTools: string[] = [];
    let recovered = false;
    for (let k = i + 1; k < lookaheadEnd; k += 1) {
      const next = events[k];
      if (next.type === "tool.call") {
        const name = next.data?.name;
        if (typeof name === "string" && name.length > 0) {
          recoveryTools.push(name);
        }
      } else if (next.type === "tool.result" && !isToolErrorResult(next)) {
        recovered = true;
        break;
      }
    }
    if (recovered && recoveryTools.length > 0) {
      motifs.push({
        failingTool,
        recoveringTool: recoveryTools[recoveryTools.length - 1],
        recoverySequence: recoveryTools,
      });
    }
  }
  return motifs;
}

export type ExplicitMatch = {
  matchedPhrase: string;
  promptExcerpt: string;
};

export function detectExplicitInstructions(events: TrajectoryEvent[]): ExplicitMatch[] {
  const matches: ExplicitMatch[] = [];
  for (const text of extractUserMessageTexts(events)) {
    const lower = text.toLowerCase();
    for (const phrase of EXPLICIT_INSTRUCTION_PHRASES) {
      if (lower.includes(phrase.toLowerCase())) {
        matches.push({
          matchedPhrase: phrase,
          promptExcerpt: text.slice(0, 200),
        });
        break;
      }
    }
  }
  return matches;
}

export function embeddingClusteringStub(): never {
  throw new Error(EMBEDDING_LANE_TODO);
}

// Phrase-level markers only: bare words like "no"/"fix"/"error" appear in
// nearly every ordinary coding request, which would pin every session at 0.5
// and make the clean-session signal unreachable.
const FRUSTRATION_MARKERS =
  /\b(not working|doesn'?t work|does not work|still (?:broken|failing|wrong)|that('?s| is) wrong|you('?re| are) wrong|incorrect|useless|disappointed|give up|never mind)\b/iu;

/**
 * Session quality signal for gate/telemetry: 1.0 = no tool errors and no
 * user frustration phrases; 0.5 otherwise. Error-recovery captures contain a
 * tool error by definition, so that lane always scores 0.5 — its skills keep
 * the stricter promotion gate.
 */
function computeSuccessScore(events: TrajectoryEvent[]): number {
  if (events.some(isToolErrorResult)) {
    return 0.5;
  }
  for (const text of extractUserMessageTexts(events)) {
    if (FRUSTRATION_MARKERS.test(text)) {
      return 0.5;
    }
  }
  return 1;
}

export type DetectorInput = {
  captureDirs: string[];
};

export async function runDetector(input: DetectorInput): Promise<Candidate[]> {
  type PerCapture = {
    captureDir: string;
    events: TrajectoryEvent[];
    toolSequence: string[];
    toolShapeHash: string;
    successScore: number;
  };
  const perCapture: PerCapture[] = [];
  const rawCandidates: Candidate[] = [];

  for (const captureDir of input.captureDirs) {
    const events = await readCaptureEvents(captureDir);
    if (events.length === 0) {
      continue;
    }
    const toolSequence = extractToolSequence(events);
    const toolShapeHash = hashToolSequence(toolSequence);
    const successScore = computeSuccessScore(events);
    perCapture.push({ captureDir, events, toolSequence, toolShapeHash, successScore });

    for (const motif of detectErrorRecovery(events)) {
      rawCandidates.push({
        lane: "error-recovery",
        candidateId: shortHash(
          `error-recovery:${captureDir}:${motif.failingTool}:${motif.recoveringTool}`,
        ),
        captureDir,
        toolSequence: motif.recoverySequence,
        failingTool: motif.failingTool,
        recoveringTool: motif.recoveringTool,
        rationale: `Recovered from ${motif.failingTool} failure by calling ${motif.recoveringTool}`,
        successScore,
      });
    }

    for (const match of detectExplicitInstructions(events)) {
      rawCandidates.push({
        lane: "explicit",
        candidateId: shortHash(`explicit:${captureDir}:${match.matchedPhrase}`),
        captureDir,
        toolSequence,
        matchedPhrase: match.matchedPhrase,
        promptExcerpt: match.promptExcerpt,
        rationale: `User explicitly asked: "${match.matchedPhrase}"`,
        successScore,
      });
    }
  }

  // ── Deduplicate error-recovery candidates by (failingTool, recoveringTool) ──
  const candidates: Candidate[] = [];
  const seenErrorRecovery = new Map<string, ErrorRecoveryCandidate>();
  const seenExplicit = new Map<string, ExplicitCandidate>();

  for (const raw of rawCandidates) {
    if (raw.lane === "error-recovery") {
      const key = `${raw.failingTool}→${raw.recoveringTool}`;
      const existing = seenErrorRecovery.get(key);
      if (existing) {
        // Merge: keep the first one found, but increment nothing — just skip duplicate
        continue;
      }
      // Re-key with a stable deduplicated ID
      const deduped: ErrorRecoveryCandidate = {
        ...raw,
        candidateId: shortHash(`error-recovery:${raw.failingTool}:${raw.recoveringTool}`),
        processVsOutcome: evaluateProcessVsOutcome({
          lane: "error-recovery",
          candidateId: raw.candidateId,
          captureDir: raw.captureDir,
          toolSequence: raw.toolSequence,
          failingTool: raw.failingTool,
          recoveringTool: raw.recoveringTool,
          rationale: raw.rationale,
          successScore: raw.successScore,
        }),
      };
      seenErrorRecovery.set(key, deduped);
      candidates.push(deduped);
    } else if (raw.lane === "explicit") {
      const key = raw.matchedPhrase?.toLowerCase() ?? "";
      if (seenExplicit.has(key)) {
        continue;
      }
      seenExplicit.set(key, {
        ...raw,
        processVsOutcome: evaluateProcessVsOutcome({
          lane: "explicit",
          candidateId: raw.candidateId,
          captureDir: raw.captureDir,
          toolSequence: raw.toolSequence,
          matchedPhrase: raw.matchedPhrase,
          promptExcerpt: raw.promptExcerpt,
          rationale: raw.rationale,
          successScore: raw.successScore,
        }),
      });
      candidates.push(seenExplicit.get(key)!);
    }
  }

  const clusters = new Map<string, PerCapture[]>();
  for (const item of perCapture) {
    if (item.toolSequence.length === 0) {
      continue;
    }
    const list = clusters.get(item.toolShapeHash) ?? [];
    list.push(item);
    clusters.set(item.toolShapeHash, list);
  }
  for (const [hash, members] of clusters) {
    if (members.length >= REPETITION_THRESHOLD) {
      // One bad session taints the cluster: the relaxed gate is only for
      // workflows whose every observed run was clean.
      const allClean = members.every((member) => member.successScore >= 1);
      candidates.push({
        lane: "tool-shape",
        candidateId: hash,
        toolShapeHash: hash,
        toolSequence: members[0].toolSequence,
        captureDirs: members.map((member) => member.captureDir),
        occurrences: members.length,
        successScore: allClean ? 1 : 0.5,
        processVsOutcome: evaluateProcessVsOutcome({
          lane: "tool-shape",
          candidateId: hash,
          toolShapeHash: hash,
          toolSequence: members[0].toolSequence,
          captureDirs: members.map((member) => member.captureDir),
          occurrences: members.length,
          successScore: allClean ? 1 : 0.5,
        }),
      });
    }
  }

  return candidates;
}

export async function writeCandidatesToForge(
  candidates: Candidate[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const dir = resolveSkillForgeCandidatesDir(env);
  await fsp.mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const candidate of candidates) {
    const file = path.join(dir, `${candidate.lane}-${candidate.candidateId}.json`);
    await fsp.writeFile(file, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    written.push(file);
  }
  return written;
}
