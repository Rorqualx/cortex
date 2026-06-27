/**
 * Agent-end side effect runner.
 *
 * Harnesses use this to trigger plugin agent_end hooks either fire-and-forget
 * or awaited during tests/shutdown. The wrapper is the single seam every
 * harness shares, so per-harness loops never reach for the hook helpers (or any
 * future core agent-end side effect) directly.
 */
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

type AgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];

/** Starts agent-end side effects without waiting for completion. */
export function runAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  runAgentHarnessAgentEndHook(params);
}

/** Runs agent-end side effects and waits for plugin completion. */
export async function awaitAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  await awaitAgentHarnessAgentEndHook(params);
}
