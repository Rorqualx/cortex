// ARCH-2 probe spike (throwaway): call-boundary hedged delegation.
// Races the primary + fallback providers in parallel; the first successful
// result wins and aborts its siblings. Members are single-candidate
// runDelegation calls so per-member latency telemetry + unusableReason
// enforcement keep working unchanged.
import type { Candidate, Route } from "./router.js";
import { runDelegation, type RunDelegationParams } from "./run-with-provider.js";

/** Max members in a hedged cohort (primary + up to cap−1 fallbacks). */
export const HEDGED_COHORT_CAP = 3;

/**
 * Build the hedged cohort from a route: distinct providers only (first
 * occurrence wins), preserving provider priority order, capped at `cap`.
 */
export function hedgedCohort(route: Route, cap = HEDGED_COHORT_CAP): Candidate[] {
  const distinct: Candidate[] = [];
  const seenProviders = new Set<string>();
  for (const member of [route.primary, ...route.fallbacks]) {
    if (seenProviders.has(member.provider)) {
      continue;
    }
    seenProviders.add(member.provider);
    distinct.push(member);
    if (distinct.length >= cap) {
      break;
    }
  }
  return distinct;
}

export type HedgedRaceResult<T> = {
  result: T;
  provider: string;
  model: string;
  race: { winner: string; lost: string[]; failed: string[] };
};

/**
 * Member run closure: same shape as RunDelegationParams["run"] plus the
 * race's AbortSignal as a 4th argument, so members can abort in-flight work
 * when a sibling wins. Production 3-arg runs ignore it harmlessly.
 */
export type HedgedRun<T> = (
  client: unknown,
  model: string,
  providerId: string,
  signal: AbortSignal,
) => Promise<T>;

/**
 * Run a hedged delegation race. Each cohort member is a single-candidate
 * runDelegation (empty fallbacks — spend bound = cohort size). The first
 * member fulfillment wins; on settle, all other members are aborted and
 * classified as `lost` (aborted while in flight) or `failed` (rejected for a
 * non-abort reason). When every member rejects, the PRIMARY member's error is
 * rethrown (not the AggregateError) so existing error surfaces keep working.
 */
export async function runHedgedDelegation<T>(
  params: Omit<RunDelegationParams<T>, "primary" | "fallbacks"> & {
    cohort: Candidate[];
    parentSignal?: AbortSignal | undefined;
  },
): Promise<HedgedRaceResult<T>> {
  const { cohort, parentSignal, ...rest } = params;
  if (cohort.length === 0) {
    throw new Error("runHedgedDelegation: empty cohort");
  }

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const memberPromises = cohort.map((member, index) =>
    runDelegation<T>({
      ...rest,
      primary: member,
      fallbacks: [],
      abortSignal: controller.signal,
      // Thread the race signal as a 4th run argument so members can abort
      // in-flight work when a sibling wins. 3-arg runs ignore it.
      run: (client, model, providerId) =>
        (rest.run as unknown as HedgedRun<T>)(client, model, providerId, controller.signal),
    }).then(
      (outcome) => ({ index, outcome }),
      (error: unknown) => {
        // Attach member index for primary-error extraction without relying
        // on AggregateError.errors ordering.
        (error as { __hedgedIndex?: number }).__hedgedIndex = index;
        throw error;
      },
    ),
  );

  try {
    const winner = await Promise.any(memberPromises);

    // First success: cancel the losers. Aborted members reject with abort-ish
    // errors (their `run` closures see the signal via the LlmClient / fetch
    // layer); classification is done after settle below.
    controller.abort();
    const settled = await Promise.allSettled(memberPromises);

    const lost: string[] = [];
    const failed: string[] = [];
    settled.forEach((entry, index) => {
      if (index === winner.index) {
        return;
      }
      if (entry.status === "fulfilled") {
        // Late fulfiller raced past the abort — result discarded, counted lost.
        lost.push(cohort[index]!.provider);
        return;
      }
      // Classify by rejection REASON, not signal state: signal.aborted is
      // always true here (the winner aborted the controller), so it cannot
      // distinguish "rejected because aborted" from "failed on its own
      // before/after the abort". An abort-ish rejection = still in flight
      // when cancelled (lost); any other error = genuine failure (failed).
      const message = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
      if (/abort|cancel/iu.test(message)) {
        lost.push(cohort[index]!.provider);
      } else {
        failed.push(cohort[index]!.provider);
      }
    });

    return {
      result: winner.outcome.result,
      provider: winner.outcome.provider,
      model: winner.outcome.model,
      race: { winner: cohort[winner.index]!.provider, lost, failed },
    };
  } catch (err) {
    if (err instanceof AggregateError) {
      const primaryError = err.errors.find(
        (e) => (e as { __hedgedIndex?: number }).__hedgedIndex === 0,
      );
      throw primaryError ?? err;
    }
    throw err;
  } finally {
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
