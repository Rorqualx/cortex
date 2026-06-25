/**
 * SimulationEnv — injectable deterministic environment for DST.
 *
 * Provides clock, seeded RNG, and an optional scripted model provider override.
 * Two implementations: default (delegates to Date.now/Math.random) and
 * deterministic (uses injected seed and virtual clock).
 */

/** Minimal deterministic environment surface. */
export interface SimulationEnv {
  /** Virtual wall-clock in milliseconds. */
  now(): number;
  /** Seeded pseudo-random in [0, 1). */
  random(): number;
}

/** Extended env for Phase 3 — includes scripted model provider override. */
export interface SimulationEnvWithModel extends SimulationEnv {
  /** When set, stream() / streamSimple() route through this provider instead of the real registry. */
  modelProvider?: ScriptedModelProvider;
}

/** A provider that can replay pre-recorded model response streams. */
export interface ScriptedModelProvider {
  /** Unique seed used to generate/script this provider's responses. */
  seed: string;
  /**
   * Produce a stream for the given model+context.
   * The implementation may look up a recorded script or generate synthetic data.
   */
  stream(
    model: unknown,
    context: unknown,
    options?: unknown,
  ): AsyncIterable<unknown> & { result(): Promise<unknown> };
  streamSimple(
    model: unknown,
    context: unknown,
    options?: unknown,
  ): AsyncIterable<unknown> & { result(): Promise<unknown> };
}

let activeEnv: SimulationEnv | undefined;

/** Return the currently active SimulationEnv, or undefined if not in simulation. */
export function getSimulationEnv(): SimulationEnv | undefined {
  return activeEnv;
}

/** Set (or clear) the active SimulationEnv. */
export function setSimulationEnv(env: SimulationEnv | undefined): void {
  activeEnv = env;
}

/** Run a callback with the given SimulationEnv active, restoring the previous one on exit. */
export function withSimulationEnv<T>(env: SimulationEnv | undefined, fn: () => T): T {
  const previous = activeEnv;
  activeEnv = env;
  try {
    return fn();
  } finally {
    activeEnv = previous;
  }
}

/** Run an async callback with the given SimulationEnv active. */
export async function withSimulationEnvAsync<T>(
  env: SimulationEnv | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = activeEnv;
  activeEnv = env;
  try {
    return await fn();
  } finally {
    activeEnv = previous;
  }
}

/** Deterministic SimulationEnv backed by a virtual clock and xorshift RNG. */
export function createDeterministicSimulationEnv(params: {
  startTimeMs?: number;
  seed: string;
}): SimulationEnv {
  let timeMs = params.startTimeMs ?? 0;
  const rng = createSeededRng(params.seed);
  return {
    now: () => timeMs,
    random: () => rng(),
  };
}

/** Default production SimulationEnv (no simulation). */
export function createDefaultSimulationEnv(): SimulationEnv {
  return {
    now: () => Date.now(),
    random: () => Math.random(),
  };
}

/**
 * Simple xorshift128+ seeded RNG.
 * Seed string is hashed into two 64-bit state values.
 */
function createSeededRng(seed: string): () => number {
  // FNV-1a hash the seed string into two 53-bit states
  let s0 = 2166136261;
  let s1 = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    s0 = Math.imul(s0 ^ c, 16777619);
    if (i % 2 === 0) {
      s1 = Math.imul(s1 ^ c, 16777619);
    }
  }
  s0 = Math.abs(s0) || 1;
  s1 = Math.abs(s1) || 1;

  return () => {
    let t = s0;
    const s = s1;
    t = t ^ (t << 23);
    t = t ^ (t >>> 17);
    t = t ^ s ^ (s >>> 26);
    s0 = s1;
    s1 = t;
    // Return value in [0, 1)
    return ((s0 + s1) >>> 0) / 4294967296;
  };
}
