/** Re-attempts steer injection across the active run's short compaction window. */
import type { EmbeddedAgentQueueMessageOutcome } from "../../agents/embedded-agent-runner/runs.js";

// A follow-up that lands while the active run is mid-compaction is rejected by
// the runtime ("cannot steer a compact turn"). Compaction is short-lived, so we
// re-attempt the steer until it settles instead of demoting the message to a
// whole-run followup — which would not be consumed until the entire run ends.
export const STEER_COMPACTION_RETRY_BUDGET_MS = 15_000;
export const STEER_COMPACTION_RETRY_POLL_MS = 250;

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Polls a steer injection while the active run reports the transient
 * `compacting` rejection. Returns the first non-compacting outcome (queued or a
 * terminal failure). Stops early once the run is no longer active, since a
 * compaction that ends by completing the whole run can no longer accept a steer.
 */
export async function steerWithCompactionRetry(params: {
  attempt: () => Promise<EmbeddedAgentQueueMessageOutcome>;
  isRunActive?: () => boolean;
  budgetMs?: number;
  pollMs?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}): Promise<EmbeddedAgentQueueMessageOutcome> {
  const now = params.now ?? Date.now;
  const delay = params.delay ?? defaultDelay;
  const budgetMs = params.budgetMs ?? STEER_COMPACTION_RETRY_BUDGET_MS;
  const pollMs = params.pollMs ?? STEER_COMPACTION_RETRY_POLL_MS;

  let outcome = await params.attempt();
  const deadline = now() + budgetMs;
  while (
    !outcome.queued &&
    outcome.reason === "compacting" &&
    now() < deadline &&
    params.isRunActive?.() !== false
  ) {
    await delay(pollMs);
    outcome = await params.attempt();
  }
  return outcome;
}
