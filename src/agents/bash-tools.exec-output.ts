/**
 * Rendering helpers for exec output/status updates.
 * Keeps no-output placeholders and warning placement consistent across exec
 * progress, polling, and completion surfaces.
 */
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { compressLogOutput } from "../compression/log-compressor.js";
import type { CompressorOutput } from "../compression/types.js";
import type { TerminationReason } from "../process/supervisor/types.js";

export const EXEC_NO_OUTPUT_PLACEHOLDER = "(no output)";
// Keep launch and later process observations consistent without naming an aliased tool.
export const EXEC_MANUAL_COLLECTION_FOLLOW_UP =
  "Automatic completion wake is disabled (tools.exec.notifyOnExit=false). If the task needs this result, use poll with a timeout to collect it before ending the turn, unless another continuation is already arranged.";
const EXEC_TIMEOUT_RETRY_GUIDANCE =
  "The command was terminated, but external side effects may already have completed. Verify the resulting state before retrying. Do not automatically rerun non-idempotent commands. Use a higher timeout only when the command is known to be safe to retry.";

// Irreversible loss leads model-visible output so later head-preserving caps retain it.
export const EXEC_RETENTION_CAP_NOTE =
  "[earlier output was discarded at the retention cap and cannot be recovered]\n\n";

/** Conservative model-visible budget (chars) for completed exec output. */
export const DEFAULT_EXEC_OUTPUT_BUDGET = 12_000;

/** Resolve the exec output containment budget, honouring the env override. */
export function resolveExecOutputBudget(): number {
  const raw = Number.parseInt(process.env.OPENCLAW_EXEC_OUTPUT_BUDGET_CHARS ?? "", 10);
  if (!Number.isFinite(raw)) {
    return DEFAULT_EXEC_OUTPUT_BUDGET;
  }
  return Math.min(200_000, Math.max(2_000, raw));
}

function containmentNote(before: number, after: number, how: string): string {
  return `[exec output contained — ${how} ${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")} chars; the full text is preserved in this tool result's details]\n`;
}

/**
 * Contain verbose completed-exec output before it enters L1. Log-like output
 * gets a content-aware digest (errors/warnings/stacks always kept, via the
 * shared log-compressor); anything else gets a head/tail excerpt with an
 * omission marker. Output at or under budget passes through untouched. Never
 * throws — containment is best-effort and must not break a completed exec.
 */
export function containExecOutputForModel(
  text: string,
  budget: number = resolveExecOutputBudget(),
): string {
  if (text.length <= budget) {
    return text;
  }
  const targetRatio = Math.min(0.5, Math.max(0.02, budget / text.length));
  let digest: CompressorOutput | null = null;
  try {
    digest = compressLogOutput(text, targetRatio);
  } catch {
    digest = null;
  }
  if (digest?.compressed && digest.content.length <= budget) {
    return containmentNote(text.length, digest.content.length, "log digest,") + digest.content;
  }
  const headBudget = Math.floor(budget * 0.6);
  const tailBudget = Math.max(0, budget - headBudget);
  const head = truncateUtf16Safe(text, headBudget);
  const tail = tailBudget > 0 ? sliceUtf16Safe(text, text.length - tailBudget) : "";
  const omitted = Math.max(0, text.length - head.length - tail.length);
  const body = tail
    ? `${head}\n[… ${omitted.toLocaleString("en-US")} chars omitted …]\n${tail}`
    : head;
  return containmentNote(text.length, body.length, "head/tail excerpt,") + body;
}

/** Render command output with a stable placeholder for empty output. */
export function renderExecOutputText(value: string | undefined): string {
  return value || EXEC_NO_OUTPUT_PLACEHOLDER;
}

/** Render the authoritative process exit without inventing a successful code. */
export function renderExecExitLabel(exit: {
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
}): string {
  if (exit.exitSignal != null) {
    return `signal ${exit.exitSignal}`;
  }
  return typeof exit.exitCode === "number" ? `code ${exit.exitCode}` : "unknown exit code";
}

/** Render the text shown in exec progress updates, including warnings first. */
export function renderExecUpdateText(params: { tailText?: string; warnings: string[] }): string {
  const warningText = params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "";
  return warningText + renderExecOutputText(params.tailText);
}

/** Add retry-safety guidance only for supervisor timeout exits. */
export function appendExecTimeoutRetryGuidance(
  text: string,
  exitReason: TerminationReason | undefined,
): string {
  if (exitReason !== "overall-timeout" && exitReason !== "no-output-timeout") {
    return text;
  }
  return `${text}\n\n${EXEC_TIMEOUT_RETRY_GUIDANCE}`;
}
