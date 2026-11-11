/**
 * ARCH-2 v2 (2026-11-11) — MemCon-style tabular UCB1 bandit wrapper for the
 * retrieval policy (design doc: memory/reports/lab/2026-11-15_9b9efeea chain,
 * card 9b9efeea). Action space is deliberately tiny — preset × topK depth
 * only; NO fact admit/deny actions (the card's named risk is exploration
 * polluting retrieval quality).
 *
 * Flag-gated OFF by default via `OPENCLAW_MEMORY_L3_BANDIT=1` (per-call env
 * read, injection-policy.ts precedent). Rewards are computed OFFLINE from the
 * retrieval_events × retrieval_outcomes correlation join; the engine only
 * SELECTS actions and records them in the telemetry — the offline lane writes
 * updated state back via `writeBanditState`.
 */

/** One selectable retrieval-policy arm: a scoring preset and a topK depth. */
export type BanditAction = { preset: string; topK: number };

/** Per-arm UCB1 bookkeeping (mean reward derived: sumReward / n). */
export type BanditArmState = { n: number; sumReward: number };

/** Tabular state: one arm bucket per `intentClass|preset|topK` key. */
export type BanditState = { arms: Record<string, BanditArmState> };

/** l3_kv key under which the serialized state lives (Storage kv helpers). */
export const BANDIT_STATE_KV_KEY = "retrieval_bandit_state";

/** UCB1 exploration constant. √2 is the standard regret-optimal choice. */
export const DEFAULT_EXPLORATION_C = Math.SQRT2;

/** Score presets the bandit may route between (scoring.ts intent presets). */
export const BANDIT_PRESETS: readonly string[] = ["factual", "multihop", "synthesis"];

/** topK depths the bandit may route between (engine floor/baseline). */
export const BANDIT_TOPKS: readonly number[] = [5, 3];

/** The full preset × depth action space (6 arms per intent). */
export function banditActionSpace(
  presets: readonly string[] = BANDIT_PRESETS,
  topKs: readonly number[] = BANDIT_TOPKS,
): BanditAction[] {
  const actions: BanditAction[] = [];
  for (const preset of presets) {
    for (const topK of topKs) {
      actions.push({ preset, topK });
    }
  }
  return actions;
}

/** Per-call env read (injection-policy.ts precedent): null = OFF (default). */
export function readBanditConfig(): { explorationC: number } | null {
  if (process.env.OPENCLAW_MEMORY_L3_BANDIT !== "1") {
    return null;
  }
  return { explorationC: DEFAULT_EXPLORATION_C };
}

function armKey(intentClass: string, action: BanditAction): string {
  return `${intentClass}|${action.preset}|${action.topK}`;
}

/**
 * UCB1 selection among `actions` for one intent class.
 * - Unexplored / least-sampled arms win cold-start (finite exploration bonus
 *   explodes as n→0, so we pick min-n deterministically).
 * - Exact ties break to the LOWEST action index (deterministic).
 */
export function selectAction(
  intentClass: string,
  actions: readonly BanditAction[],
  state: BanditState,
  explorationC: number = DEFAULT_EXPLORATION_C,
): BanditAction {
  if (actions.length === 0) {
    throw new Error("selectAction requires at least one action");
  }
  let totalPulls = 0;
  for (const action of actions) {
    totalPulls += state.arms[armKey(intentClass, action)]?.n ?? 0;
  }
  // Cold start: nobody pulled anything → deterministic first action.
  if (totalPulls === 0) {
    return actions[0]!;
  }
  const logTotal = Math.log(totalPulls);
  let bestIndex = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const arm = state.arms[armKey(intentClass, action)];
    if (!arm || arm.n === 0) {
      // Unexplored arm: infinite UCB — pick the least-sampled (then lowest
      // index, preserved by strict > comparison below).
      const n = arm?.n ?? 0;
      const score = Infinity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
      void n;
      continue;
    }
    const mean = arm.sumReward / arm.n;
    const score = mean + explorationC * Math.sqrt(logTotal / arm.n);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return actions[bestIndex]!;
}

/** Bayesian-free tabular update: one pull, one reward ∈ [0,1]. */
export function updateBandit(
  state: BanditState,
  intentClass: string,
  action: BanditAction,
  reward: number,
): BanditState {
  const key = armKey(intentClass, action);
  const arm = state.arms[key] ?? { n: 0, sumReward: 0 };
  return {
    arms: {
      ...state.arms,
      [key]: { n: arm.n + 1, sumReward: arm.sumReward + reward },
    },
  };
}

/** Serialize for the l3_kv round-trip (counts/means preserved exactly). */
export function serializeBanditState(state: BanditState): string {
  return JSON.stringify(state);
}

/** Parse a serialized state; null on corrupt input (never throws). */
export function parseBanditState(raw: string): BanditState | null {
  try {
    const parsed = JSON.parse(raw) as { arms?: unknown };
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.arms !== "object" ||
      parsed.arms === null
    ) {
      return null;
    }
    const arms: Record<string, BanditArmState> = {};
    for (const [key, value] of Object.entries(parsed.arms as Record<string, unknown>)) {
      const arm = value as { n?: unknown; sumReward?: unknown };
      if (
        typeof arm?.n === "number" &&
        Number.isFinite(arm.n) &&
        typeof arm?.sumReward === "number" &&
        Number.isFinite(arm.sumReward)
      ) {
        arms[key] = { n: arm.n, sumReward: arm.sumReward };
      }
    }
    return { arms };
  } catch {
    return null;
  }
}

/**
 * Engine consult seam: returns the selected action, or null when the flag is
 * OFF (the default) — in which case the caller must not touch bandit state at
 * all (structural default-off, T-B4: no env reaches vitest workers reliably).
 */
export function consultBandit(
  intentClass: string,
  actions: readonly BanditAction[],
  readState: () => string | null,
  config: { explorationC: number } | null,
): BanditAction | null {
  if (!config) {
    return null;
  }
  const raw = readState();
  const state = raw === null ? { arms: {} } : (parseBanditState(raw) ?? { arms: {} });
  return selectAction(intentClass, actions, state, config.explorationC);
}
