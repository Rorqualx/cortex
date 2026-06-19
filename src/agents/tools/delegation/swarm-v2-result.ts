// Pure result helpers for the v2 swarm: the single source of truth for
// "did an agent succeed" and for picking the tree's final halt reason +
// user-facing content. Kept side-effect-free so swarm-v2-loop stays thin and
// these decisions are unit-testable without a live provider.

import type { ExploreResult, ExploreStats } from "./explore-loop.js";
import type { SubagentV2Result, SwarmV2HaltReason } from "./swarm-v2-types.js";

/**
 * Canonical ok-derivation for any agent (CEO or sub-agent). An agent only
 * counts as ok when the explore-loop reported success AND it emitted non-empty
 * content. The empty-content case is a real failure mode: K2.6 reasoning
 * runaway can return subtype=success with no synthesis, so we treat it as not-ok
 * and surface why. Shared by the CEO record (swarm-v2-loop) and the sub-agent
 * record (swarm-v2-spawn) so the contract can't drift between them.
 */
export function deriveAgentOk(
  stats: ExploreStats,
  content: string,
): { ok: boolean; errorReason?: string } {
  const subtypeOk = stats.subtype === "success";
  const contentEmpty = content.trim().length === 0;
  if (subtypeOk && !contentEmpty) return { ok: true };
  const errorReason = !subtypeOk
    ? `subtype=${stats.subtype} halt=${stats.haltReason}`
    : `subtype=success but empty content (likely reasoning runaway at synthesis turn; outputTokens=${stats.outputTokens})`;
  return { ok: false, errorReason };
}

export interface AdjudicateHaltInput {
  task: string;
  ceoResult: ExploreResult | null;
  runError: string | null;
  /** state.wallController.signal.aborted — true iff the HARD wall fired. */
  wallAborted: boolean;
  /** The whole tree (CEO at index 0). */
  flatAgents: SubagentV2Result[];
  spawnedCount: number;
  maxTotalSubagents: number;
}

/**
 * Resolve the final {haltReason, content} from the CEO outcome + the sub-agent
 * tree. Precedence (highest first): CEO crash -> empty synthesis -> hard wall ->
 * CEO's own soft halts -> spawn-budget-exhausted-and-all-failed -> all-failed ->
 * clean stop. The tree is partitioned ONCE here; callers must not re-derive this
 * ordering elsewhere (that drift was the original ladder's smell).
 *
 * Invariant exploited below: once the empty-synthesis case returns, every later
 * branch sees non-empty trimmed CEO content.
 */
export function adjudicateHalt(input: AdjudicateHaltInput): {
  haltReason: SwarmV2HaltReason;
  content: string;
} {
  const { task, ceoResult, runError, wallAborted, flatAgents, spawnedCount, maxTotalSubagents } =
    input;

  // Only workers count toward swarm success/failure. Verifiers are adversarial
  // skeptics — a refuted claim is a verifier doing its job, not a swarm failure.
  const subs = flatAgents.filter((a) => a.depth > 0 && a.kind !== "verifier");
  const okSubs = subs.filter((a) => a.ok);
  const ceoContent = (ceoResult?.content ?? "").trim();
  const ceoHalt = ceoResult?.stats.haltReason;

  if (!ceoResult) {
    return {
      haltReason: "error",
      content: `[swarm v2 error] CEO explore-loop failed: ${runError ?? "unknown"}`,
    };
  }

  if (ceoContent.length === 0) {
    // Mirror v1's fallbackSynthesis: never drop sub-agent work just because the
    // CEO emitted nothing.
    return {
      haltReason: "ceo_synthesis_empty",
      content: fallbackSynthesisV2(task, flatAgents, "CEO produced empty content"),
    };
  }

  if (wallAborted) {
    // HARD wall abort: ceoContent is a partial/mid-reasoning fragment, NOT an
    // answer. Emit the sub-agents' completed verdicts verbatim and append the
    // CEO's partial notes as context. (Layer-1 synthesis reserve makes this rare;
    // this is the safety net when synthesis overruns it.)
    if (okSubs.length > 0) {
      const base = fallbackSynthesisV2(
        task,
        flatAgents,
        "wall budget hit before the CEO could synthesize",
      );
      return {
        haltReason: "wall_cap",
        content: `${base}\n\n## CEO partial notes (incomplete — wall hit mid-synthesis)\n\n${ceoContent}`,
      };
    }
    return { haltReason: "wall_cap", content: ceoContent };
  }

  if (ceoHalt === "wall_cap") {
    // Graceful soft-wall synthesis: the CEO crossed the synthesis-reserve
    // deadline and produced a real answer before the hard wall fired.
    return { haltReason: "wall_cap", content: ceoContent };
  }
  if (ceoHalt === "iter_cap") return { haltReason: "ceo_iter_cap", content: ceoContent };
  if (ceoHalt === "no_progress") return { haltReason: "ceo_no_progress", content: ceoContent };

  const allSubsFailed = subs.length > 0 && okSubs.length === 0;

  // Budget exhausted AND every sub-agent failed: nothing trustworthy to emit, so
  // fall back to raw outputs. spawnedCount counts the CEO (index 0), hence -1.
  if (spawnedCount > maxTotalSubagents - 1 && allSubsFailed) {
    return {
      haltReason: "spawn_budget_exhausted",
      content: fallbackSynthesisV2(
        task,
        flatAgents,
        "spawn budget exhausted with all sub-agents failed",
      ),
    };
  }

  // Sub-agents ran but all failed; the CEO still synthesized from fs-tool work.
  if (allSubsFailed) {
    return {
      haltReason: "all_subagents_failed",
      content: `[swarm v2 note] all ${subs.length} sub-agents failed; CEO synthesized from fs-tool work alone:\n\n${ceoContent}`,
    };
  }

  return { haltReason: "stop", content: ceoContent };
}

/**
 * Degradation path: emit every successful sub-agent's content verbatim plus a
 * list of failures. Used whenever the CEO can't be trusted to have synthesized
 * (empty content, hard-wall abort, budget exhaustion). Preserving raw sub-agent
 * work is the product contract — we never silently lose completed verdicts.
 */
export function fallbackSynthesisV2(
  task: string,
  agents: SubagentV2Result[],
  reason: string,
): string {
  // Workers only — same contract as adjudicateHalt. Verifiers are adversarial
  // skeptics; their "VERDICT: REFUTED…" reasoning is not a research finding and
  // must never be emitted to the user as one.
  const subagents = agents.filter((a) => a.depth > 0 && a.kind !== "verifier");
  if (subagents.length === 0) {
    return `[swarm v2 fallback] ${reason}; no sub-agents were spawned. Original task:\n${task}`;
  }
  const okSubs = subagents.filter((a) => a.ok);
  const failSubs = subagents.filter((a) => !a.ok);
  const lines: string[] = [
    `[swarm v2 fallback synthesis] ${reason}; emitting raw sub-agent outputs verbatim.`,
    "",
    `Original task: ${task}`,
    "",
    `Sub-agent results: ${okSubs.length} ok, ${failSubs.length} failed.`,
    "",
  ];
  for (const a of okSubs) {
    lines.push(
      `## Sub-agent ${a.index} (depth=${a.depth}, ${a.iterations} iters, ${(a.latencyMs / 1000).toFixed(1)}s)`,
      `**Objective:** ${a.objective}`,
      "",
      a.content,
      "",
    );
  }
  if (failSubs.length > 0) {
    lines.push("## Failed sub-agents", "");
    for (const a of failSubs) {
      lines.push(`- Sub-agent ${a.index} (depth=${a.depth}): ${a.error ?? "unknown error"}`);
    }
  }
  return lines.join("\n");
}
