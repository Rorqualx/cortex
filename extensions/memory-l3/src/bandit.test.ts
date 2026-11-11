import { describe, expect, it } from "vitest";
import {
  banditActionSpace,
  BANDIT_STATE_KV_KEY,
  consultBandit,
  parseBanditState,
  readBanditConfig,
  selectAction,
  serializeBanditState,
  updateBandit,
  type BanditAction,
  type BanditState,
} from "./bandit.js";

// ARCH-2 v2 (2026-11-11, card 9b9efeea): tabular UCB1 over the tiny
// preset×topK action space, flag OFF by default. Tests follow the
// 2026-11-09 test manifest T-B1..T-B4 (structural default-off — env gates
// don't reliably reach vitest workers, so T-B4 asserts the config read).

const ACTIONS: BanditAction[] = banditActionSpace();

describe("retrieval bandit (ARCH-2 v2, 2026-11-11)", () => {
  it("UCB1 selects least-sampled arm on cold-start and ties (T-B1)", () => {
    // Cold start, all-unexplored → deterministic first action.
    expect(selectAction("factual", ACTIONS, { arms: {} })).toEqual(ACTIONS[0]);

    // One arm pulled once → every other arm is unexplored (least-sampled);
    // exact tie among them breaks to the lowest index.
    const state = updateBandit({ arms: {} }, "factual", ACTIONS[3]!, 1);
    expect(selectAction("factual", ACTIONS, state)).toEqual(ACTIONS[0]);

    // All arms equally sampled (n=2 each) → the exploration terms cancel
    // and exploitation is deterministic: the higher-mean arm wins at equal n.
    let tied: BanditState = { arms: {} };
    for (const action of ACTIONS) {
      tied = updateBandit(tied, "factual", action, 1);
      tied = updateBandit(tied, "factual", action, action === ACTIONS[0] ? 1 : 0);
    }
    expect(selectAction("factual", ACTIONS, tied)).toEqual(ACTIONS[0]);
  });

  it("UCB1 converges to the best arm on a synthetic stream (T-B2)", () => {
    const actions: BanditAction[] = [
      { preset: "factual", topK: 5 },
      { preset: "factual", topK: 3 },
    ];
    // Deterministic LCG so the convergence assertion can't flake.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let state: BanditState = { arms: {} };
    let picksOfBest = 0;
    for (let i = 0; i < 200; i++) {
      const pick = selectAction("factual", actions, state);
      if (i >= 150 && pick === actions[0]) {
        picksOfBest += 1;
      }
      const reward = pick === actions[0] ? (rand() < 0.8 ? 1 : 0) : rand() < 0.3 ? 1 : 0;
      state = updateBandit(state, "factual", pick, reward);
    }
    // Arm A rewards 0.8 vs arm B 0.3 — UCB1 must exploit A >80% of last 50.
    expect(picksOfBest).toBeGreaterThan(40);
  });

  it("bandit state round-trips via serialization (T-B3)", () => {
    let state: BanditState = { arms: {} };
    state = updateBandit(state, "factual", { preset: "synthesis", topK: 5 }, 1);
    state = updateBandit(state, "factual", { preset: "synthesis", topK: 5 }, 0);
    state = updateBandit(state, "multihop", { preset: "factual", topK: 3 }, 1);
    const raw = serializeBanditState(state);
    expect(parseBanditState(raw)).toEqual(state); // counts/means preserved exactly
    expect(parseBanditState("{not json")).toBeNull();
    expect(parseBanditState('{"arms":"nope"}')).toBeNull();
  });

  it("flag OFF default: consult touches nothing (T-B4, structural)", () => {
    delete process.env.OPENCLAW_MEMORY_L3_BANDIT;
    expect(readBanditConfig()).toBeNull();
    // When the flag is OFF the state reader must never even run — the
    // structural default-off guarantee (no exploration pollution).
    expect(
      consultBandit(
        "factual",
        ACTIONS,
        () => {
          throw new Error("bandit state must not be read when flag is OFF");
        },
        readBanditConfig(),
      ),
    ).toBeNull();
    expect(BANDIT_STATE_KV_KEY).toBe("retrieval_bandit_state");
  });
});
