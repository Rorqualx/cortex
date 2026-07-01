// Per-provider in-flight request gate.
//
// Some providers (notably subscription/coding-plan endpoints such as Z.ai, which
// returns HTTP 429 `code:"1302" "Rate limit reached for requests"`) reject
// requests once more than a small number run at the same time. Without a gate,
// OpenClaw dispatches every queued model call concurrently and trips that ceiling
// on the first burst, which then escalates to a fallback model. This module caps
// simultaneous in-flight requests per provider so excess calls queue (FIFO)
// instead of failing.
//
// The acquired slot must be held for the WHOLE streamed response — providers count
// active streams, not just request initiation — so callers release only after the
// response body finishes/errors/cancels. A limit of undefined/<=0 means no gate is
// configured and acquire resolves immediately with a no-op release.

type ProviderGate = {
  limit: number;
  active: number;
  queue: Array<() => void>;
};

const gates = new Map<string, ProviderGate>();

const NOOP_RELEASE = (): void => {};

/**
 * Acquire an in-flight request slot for `key` (typically a provider id). Resolves
 * once a slot is free (immediately when under the limit, otherwise after an active
 * request releases). The returned release function is idempotent and MUST be called
 * exactly once when the request — including its streamed body — is fully done.
 */
export async function acquireProviderRequestSlot(
  key: string,
  limit: number | undefined,
  signal?: AbortSignal,
): Promise<() => void> {
  if (limit === undefined || limit <= 0) {
    return NOOP_RELEASE;
  }
  let gate = gates.get(key);
  if (!gate) {
    gate = { limit, active: 0, queue: [] };
    gates.set(key, gate);
  } else {
    // One provider account shares a single concurrency ceiling across all its
    // models, so if models resolve different maxConcurrentRequests values we honor
    // the tightest to never over-admit and re-trip the provider's 429. The gate is
    // process-local runtime state; raising a cap takes effect on gateway restart.
    gate.limit = Math.min(gate.limit, limit);
  }
  const currentGate = gate;

  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    const next = currentGate.queue.shift();
    if (next) {
      // Hand the slot directly to the next waiter; active count stays constant.
      next();
      return;
    }
    currentGate.active = Math.max(0, currentGate.active - 1);
  };

  if (currentGate.active < currentGate.limit) {
    currentGate.active += 1;
    return release;
  }
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The request was aborted.", "AbortError");
  }
  // Wait for a slot; a queued request that is cancelled must drop out of the queue
  // immediately instead of blocking on an unrelated in-flight stream's release.
  await new Promise<void>((resolve, reject) => {
    const grant = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      const idx = currentGate.queue.indexOf(grant);
      if (idx >= 0) {
        currentGate.queue.splice(idx, 1);
      }
      cleanup();
      reject(signal?.reason ?? new DOMException("The request was aborted.", "AbortError"));
    };
    currentGate.queue.push(grant);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return release;
}

/** Test-only: clear all gate state so suites do not leak in-flight counts. */
export function __resetProviderConcurrencyGatesForTest(): void {
  gates.clear();
}
