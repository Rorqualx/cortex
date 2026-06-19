// Adversarial verification layer for the v2 swarm.
//
// `makeVerifyClaimsTool(...)` returns the CEO-only `verify_claims` extra-tool.
// For each load-bearing claim it fans out K independent skeptic sub-agents —
// each a leaf runExploreLoop prompted to REFUTE — and applies a majority-refute
// vote: a claim survives only if fewer than a majority of skeptics refute it.
//
// This mirrors swarm-v2-spawn.ts but is simpler: verifiers are leaves (no
// recursion, no extraTools), the tool is CEO-only (depth 0, outside the
// semaphore, so no RAII slot dance), and the verdict is a parsed token, not a
// nested tree. Verifiers DO consume the shared tree budget via
// state.tryReserveAgentSlot — verification is not free.

import { runExploreLoop, type ExploreInput, type ExploreResult } from "./explore-loop.js";
import type { ExploreToolName } from "./explore-tools.js";
import type { LlmClient } from "./providers/types.js";
import { deriveAgentOk } from "./swarm-v2-result.js";
import type { SwarmV2SharedState } from "./swarm-v2-state.js";
import { SYSTEM_PROMPTS } from "./system-prompts.js";
import {
  MAX_CLAIMS_PER_VERIFY_CALL,
  MAX_VERIFIERS_PER_CLAIM,
  SUBAGENT_CONTENT_CAP_TO_PARENT,
  VERIFIERS_PER_CLAIM_DEFAULT,
  type ClaimVerdict,
  type ExtraTool,
  type ExtraToolCtx,
  type ExtraToolResult,
  type SubagentV2Result,
  type SwarmV2Input,
  type Verdict,
  type VerifyClaimSpec,
} from "./swarm-v2-types.js";

// Skeptics only read — they refute by inspecting the codebase, not by writing.
const VERIFIER_TOOLS: ExploreToolName[] = ["list_dir", "read_file", "glob", "grep"];
const VERIFIER_MAX_ITERS = 12; // enough to read a handful of files and decide
const VERIFIER_BUDGET_TOKENS = 4000; // a verdict + brief justification, not an essay
const VERIFIER_EXCERPT_CAP = 600; // per-verifier reasoning shown back to the CEO

// === Verdict parsing + tally (pure; unit-tested) ===

/**
 * Read a skeptic's verdict from its free-text output. Fail-closed: only an
 * explicit `VERDICT: SUPPORTED` counts as supported. A missing token, UNCERTAIN,
 * REFUTED, or empty content all resolve to "refuted" — an unconfirmable claim is
 * a refuted claim.
 */
export function parseVerdict(content: string): Verdict {
  const matches = [...content.matchAll(/VERDICT:\s*(REFUTED|SUPPORTED|UNCERTAIN)/gi)];
  const last = matches.at(-1);
  if (last && last[1]!.toUpperCase() === "SUPPORTED") return "supported";
  return "refuted";
}

/** Majority-refute vote. A claim survives iff refuted votes are below a majority. */
export function tallyClaim(verdicts: Verdict[]): {
  refutedVotes: number;
  supportedVotes: number;
  survived: boolean;
} {
  const refutedVotes = verdicts.filter((v) => v === "refuted").length;
  const supportedVotes = verdicts.length - refutedVotes;
  const majority = Math.floor(verdicts.length / 2) + 1;
  return { refutedVotes, supportedVotes, survived: refutedVotes < majority };
}

// === Validation ===

interface ValidationFailure {
  index: number;
  reason: string;
}
interface ValidatedClaim {
  spec: VerifyClaimSpec;
  index: number;
}

function validateClaims(
  raw: unknown,
): { ok: ValidatedClaim[]; failures: ValidationFailure[] } | { fatal: string } {
  if (!raw || typeof raw !== "object") return { fatal: "args must be an object" };
  const r = raw as Record<string, unknown>;
  const claims = r.claims;
  if (!Array.isArray(claims)) return { fatal: "args.claims must be an array" };
  if (claims.length === 0) return { fatal: "args.claims must have at least 1 element" };
  if (claims.length > MAX_CLAIMS_PER_VERIFY_CALL) {
    return { fatal: `args.claims max ${MAX_CLAIMS_PER_VERIFY_CALL} per call (got ${claims.length})` };
  }

  const ok: ValidatedClaim[] = [];
  const failures: ValidationFailure[] = [];
  for (let i = 0; i < claims.length; i++) {
    const item = claims[i];
    if (!item || typeof item !== "object") {
      failures.push({ index: i, reason: "claim must be an object" });
      continue;
    }
    const c = item as Record<string, unknown>;
    if (typeof c.claim !== "string" || c.claim.trim().length < 10) {
      failures.push({ index: i, reason: "claim must be a string of length >= 10" });
      continue;
    }
    let evidence: string | undefined;
    if (c.evidence !== undefined) {
      if (typeof c.evidence !== "string") {
        failures.push({ index: i, reason: "evidence must be a string" });
        continue;
      }
      evidence = c.evidence;
    }
    let contextIndices: number[] | undefined;
    if (c.context_indices !== undefined) {
      if (!Array.isArray(c.context_indices)) {
        failures.push({ index: i, reason: "context_indices must be an array of integers" });
        continue;
      }
      contextIndices = [];
      let bad = false;
      for (const v of c.context_indices) {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
          bad = true;
          break;
        }
        contextIndices.push(v);
      }
      if (bad) {
        failures.push({ index: i, reason: "context_indices must be non-negative integers" });
        continue;
      }
    }
    ok.push({
      spec: {
        claim: c.claim.trim(),
        ...(evidence !== undefined ? { evidence } : {}),
        ...(contextIndices !== undefined ? { context_indices: contextIndices } : {}),
      },
      index: i,
    });
  }
  return { ok, failures };
}

// === One skeptic ===

interface RunOneVerifierInput {
  parentInput: SwarmV2Input;
  client: LlmClient;
  state: SwarmV2SharedState;
  spec: VerifyClaimSpec;
  parentIndex: number;
  myIndex: number;
  myDepth: number;
}

async function runOneVerifierV2(input: RunOneVerifierInput): Promise<SubagentV2Result> {
  const { parentInput, client, state, spec, parentIndex, myIndex, myDepth } = input;
  const start = Date.now();
  await state.semaphore.acquire();
  try {
    const contextSlice =
      spec.context_indices && parentInput.contextItems
        ? spec.context_indices
            .filter((i) => i >= 0 && i < parentInput.contextItems!.length)
            .map((i) => parentInput.contextItems![i]!)
        : undefined;

    const task =
      `Adversarially verify the following claim by trying to REFUTE it.\n\n` +
      `CLAIM: ${spec.claim}\n` +
      (spec.evidence ? `STATED EVIDENCE: ${spec.evidence}\n` : "") +
      `\nInvestigate with the tools. A claim you cannot independently confirm or ` +
      `reproduce is REFUTED. End with exactly "VERDICT: REFUTED" or "VERDICT: SUPPORTED".`;

    const verifierInput: ExploreInput = {
      task,
      roots: parentInput.roots,
      contextItems: contextSlice,
      model: parentInput.subagentModel ?? parentInput.model,
      thinking: true, // refutation is analytical
      format: "markdown",
      maxIterations: VERIFIER_MAX_ITERS,
      maxOutputTokens: VERIFIER_BUDGET_TOKENS,
      allowedTools: VERIFIER_TOOLS,
      wallTimeMs: Math.max(60_000, parentInput.wallTimeMs ?? 1_200_000),
      maxBudgetUsd: parentInput.maxBudgetUsd,
      wallSignal: state.wallController.signal,
      wallDeadlineMs: state.startedAt + state.wallMs,
      systemPromptAppendix: SYSTEM_PROMPTS.swarm_v2_verifier,
      // No extraTools / extraToolCtx: verifiers are leaves and hold their slot
      // for their whole run (no children to release it for).
    };

    let result: ExploreResult | null = null;
    let runError: string | null = null;
    try {
      result = await runExploreLoop(client, verifierInput);
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
    }

    if (!result) {
      return {
        index: myIndex,
        parentIndex,
        depth: myDepth,
        kind: "verifier",
        ok: false,
        objective: spec.claim,
        allowedTools: VERIFIER_TOOLS,
        thinking: true,
        iterations: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - start,
        error: runError ?? "explore-loop returned null",
        content: "",
        childIndices: [],
      };
    }

    const { stats, content } = result;
    const { ok, errorReason } = deriveAgentOk(stats, content ?? "");
    return {
      index: myIndex,
      parentIndex,
      depth: myDepth,
      kind: "verifier",
      ok,
      objective: spec.claim,
      allowedTools: VERIFIER_TOOLS,
      thinking: true,
      iterations: stats.iterations,
      toolCalls: stats.toolCalls,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      ...(stats.cacheHitTokens !== undefined ? { cacheHitTokens: stats.cacheHitTokens } : {}),
      latencyMs: Date.now() - start,
      ...(stats.costUsd !== undefined ? { costUsd: stats.costUsd } : {}),
      ...(stats.stopReason ? { finishReason: stats.stopReason } : {}),
      ...(errorReason ? { error: errorReason } : {}),
      content: content ?? "",
      childIndices: [],
    };
  } finally {
    state.semaphore.release();
  }
}

// === Tool definition ===

function makeVerifyToolDefinition(state: SwarmV2SharedState): ExtraTool["definition"] {
  return {
    type: "function",
    function: {
      name: "verify_claims",
      description:
        `Adversarially verify your load-bearing findings before final synthesis. ` +
        `Each claim is judged by ${VERIFIERS_PER_CLAIM_DEFAULT} independent skeptic sub-agents ` +
        `(override with verifiers_per_claim, max ${MAX_VERIFIERS_PER_CLAIM}), each trying to REFUTE it. ` +
        `A claim SURVIVES only if a majority fail to refute it; otherwise treat it as unproven. ` +
        `Verifiers share the tree budget (${state.remainingSlots()} slots left), so verify what ` +
        `matters — bugs, severities, file:line claims — not everything. Max ${MAX_CLAIMS_PER_VERIFY_CALL} claims per call.`,
      parameters: {
        type: "object",
        properties: {
          claims: {
            type: "array",
            minItems: 1,
            maxItems: MAX_CLAIMS_PER_VERIFY_CALL,
            items: {
              type: "object",
              required: ["claim"],
              properties: {
                claim: {
                  type: "string",
                  minLength: 10,
                  description: "The specific, self-contained claim to put under scrutiny.",
                },
                evidence: {
                  type: "string",
                  description: "Optional supporting evidence to hand the skeptics (file:line, metric, quote).",
                },
                context_indices: {
                  type: "array",
                  items: { type: "integer", minimum: 0 },
                  description: "Zero-based indices into your context array routed to each skeptic.",
                },
              },
            },
          },
          verifiers_per_claim: {
            type: "integer",
            minimum: 1,
            maximum: MAX_VERIFIERS_PER_CLAIM,
            description: `Skeptics per claim (default ${VERIFIERS_PER_CLAIM_DEFAULT}).`,
          },
        },
        required: ["claims"],
      },
    },
  };
}

// === The verify_claims tool factory ===

/**
 * Build the verify_claims extra-tool for the CEO (parentDepth 0). Verifiers run
 * at parentDepth+1 as leaf skeptics. `parentChildIndices` is shared so the CEO's
 * result lists the verifier indices it spawned.
 */
export function makeVerifyClaimsTool(
  parentIndex: number,
  parentDepth: number,
  parentInput: SwarmV2Input,
  client: LlmClient,
  state: SwarmV2SharedState,
  parentChildIndices?: number[],
): ExtraTool {
  return {
    name: "verify_claims",
    definition: makeVerifyToolDefinition(state),
    handler: async (args, _ctx: ExtraToolCtx): Promise<ExtraToolResult> => {
      const validation = validateClaims(args);
      if ("fatal" in validation) {
        return {
          content: `[verify_claims error] ${validation.fatal}\n\nRetry with a valid claims array.`,
          meta: { error: "fatal_validation", reason: validation.fatal },
        };
      }
      if (validation.ok.length === 0) {
        const lines = validation.failures.map((f) => `  [${f.index}] ${f.reason}`).join("\n");
        return {
          content: `[verify_claims error] all ${validation.failures.length} claims failed validation:\n${lines}`,
          meta: { error: "all_invalid", failures: validation.failures },
        };
      }

      const rawK = (args as Record<string, unknown>).verifiers_per_claim;
      const k =
        typeof rawK === "number" && Number.isInteger(rawK)
          ? Math.max(1, Math.min(MAX_VERIFIERS_PER_CLAIM, rawK))
          : VERIFIERS_PER_CLAIM_DEFAULT;
      const childDepth = parentDepth + 1;

      // Reserve up to k slots per claim from the shared budget. Once the budget
      // is exhausted, later claims get fewer (or zero) skeptics — reported as
      // UNVERIFIED so the CEO knows they are unproven, not silently "survived".
      const reservedByClaim: number[][] = validation.ok.map(() => []);
      const allReserved: Array<{ claimIdx: number; index: number }> = [];
      outer: for (let ci = 0; ci < validation.ok.length; ci++) {
        for (let v = 0; v < k; v++) {
          const idx = state.tryReserveAgentSlot();
          if (idx === null) break outer;
          reservedByClaim[ci]!.push(idx);
          allReserved.push({ claimIdx: ci, index: idx });
        }
      }

      const settled = await Promise.allSettled(
        allReserved.map((r) =>
          runOneVerifierV2({
            parentInput,
            client,
            state,
            spec: validation.ok[r.claimIdx]!.spec,
            parentIndex,
            myIndex: r.index,
            myDepth: childDepth,
          }).then((res) => ({ claimIdx: r.claimIdx, res })),
        ),
      );

      const recordsByClaim: SubagentV2Result[][] = validation.ok.map(() => []);
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i]!;
        const { claimIdx, index } = allReserved[i]!;
        const res =
          s.status === "fulfilled"
            ? s.value.res
            : ({
                index,
                parentIndex,
                depth: childDepth,
                kind: "verifier",
                ok: false,
                objective: validation.ok[claimIdx]!.spec.claim,
                allowedTools: VERIFIER_TOOLS,
                thinking: true,
                iterations: 0,
                toolCalls: 0,
                inputTokens: 0,
                outputTokens: 0,
                latencyMs: 0,
                error: s.reason instanceof Error ? s.reason.message : String(s.reason),
                content: "",
                childIndices: [],
              } satisfies SubagentV2Result);
        state.recordAgent(res);
        parentChildIndices?.push(res.index);
        recordsByClaim[claimIdx]!.push(res);
      }

      // Tally each claim; claims that got no skeptic (budget) are unverified.
      const verdicts: ClaimVerdict[] = [];
      const unverified: number[] = [];
      let survivedCount = 0;
      let refutedCount = 0;
      for (let ci = 0; ci < validation.ok.length; ci++) {
        const records = recordsByClaim[ci]!;
        if (records.length === 0) {
          unverified.push(ci);
          continue;
        }
        const t = tallyClaim(records.map((r) => parseVerdict(r.content)));
        if (t.survived) survivedCount++;
        else refutedCount++;
        verdicts.push({
          claim: validation.ok[ci]!.spec.claim,
          survived: t.survived,
          refutedVotes: t.refutedVotes,
          supportedVotes: t.supportedVotes,
          verifierIndices: reservedByClaim[ci]!,
        });
      }
      state.recordVerification(verdicts.length, survivedCount, refutedCount);

      return {
        content: renderVerifyResult(verdicts, unverified, validation.ok, recordsByClaim, k, state),
        meta: {
          verifiedClaims: verdicts.length,
          survived: survivedCount,
          refuted: refutedCount,
          unverified: unverified.length,
          verifiersPerClaim: k,
        },
      };
    },
  };
}

function renderVerifyResult(
  verdicts: ClaimVerdict[],
  unverified: number[],
  validated: ValidatedClaim[],
  recordsByClaim: SubagentV2Result[][],
  k: number,
  state: SwarmV2SharedState,
): string {
  const lines: string[] = [
    `verify_claims complete: ${verdicts.filter((v) => v.survived).length} survived, ` +
      `${verdicts.filter((v) => !v.survived).length} refuted, ${unverified.length} unverified ` +
      `(${k} skeptics/claim). Tree: spawned=${state.subagentCount()}/${state.subagentCapacity()}.`,
  ];
  for (let ci = 0; ci < validated.length; ci++) {
    const claim = validated[ci]!.spec.claim;
    if (unverified.includes(ci)) {
      lines.push(`\n[Claim ${ci} — UNVERIFIED (no budget)] ${claim}`);
      continue;
    }
    const v = verdicts.find((x) => x.claim === claim)!;
    const tag = v.survived ? "SURVIVED" : "REFUTED";
    lines.push(
      `\n[Claim ${ci} — ${tag}, ${v.refutedVotes}/${v.refutedVotes + v.supportedVotes} refuted] ${claim}`,
    );
    for (const rec of recordsByClaim[ci]!) {
      const verdict = parseVerdict(rec.content).toUpperCase();
      const excerpt =
        rec.content.length > VERIFIER_EXCERPT_CAP
          ? rec.content.slice(0, VERIFIER_EXCERPT_CAP) + "…"
          : rec.content || "(no content)";
      lines.push(`  · skeptic ${rec.index} [${verdict}]: ${excerpt}`);
    }
  }
  if (unverified.length > 0) {
    lines.push(
      `\nUNVERIFIED claims had no verification budget — treat them as unproven in your synthesis.`,
    );
  }
  return lines.join("\n");
}
