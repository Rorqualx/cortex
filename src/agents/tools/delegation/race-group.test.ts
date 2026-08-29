// ARCH-2 probe spike tests (throwaway): hedged race semantics.
import { describe, expect, it } from "vitest";
import type { Candidate, Route } from "./router.js";
import { HEDGED_COHORT_CAP, hedgedCohort, runHedgedDelegation } from "./race-group.js";

const authResolver = () => ({ apiKey: "***" });

function deferredAbortable(signal: AbortSignal, label: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(`aborted: ${label}`));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error(`aborted: ${label}`)),
      { once: true },
    );
  });
}

function hedged<T>(
  cohort: Candidate[],
  run: (providerId: string, signal: AbortSignal) => Promise<T>,
) {
  return runHedgedDelegation<T>({
    cfg: undefined,
    cohort,
    resolveApiKeyForProvider: authResolver,
    run: (_client, _model, providerId, signal) => run(providerId, signal),
  });
}

describe("hedgedCohort", () => {
  it("caps cohort at HEDGED_COHORT_CAP and keeps distinct providers in priority order", () => {
    const route: Route = {
      primary: { provider: "zai", model: "m1" },
      fallbacks: [
        { provider: "zai", model: "m2" },
        { provider: "deepseek", model: "m3" },
        { provider: "kimi", model: "m4" },
        { provider: "moonshot", model: "m5" },
      ],
    };
    const cohort = hedgedCohort(route);
    expect(cohort).toEqual([
      { provider: "zai", model: "m1" },
      { provider: "deepseek", model: "m3" },
      { provider: "kimi", model: "m4" },
    ]);
    expect(cohort.length).toBeLessThanOrEqual(HEDGED_COHORT_CAP);
  });

  it("returns a single-member cohort when the route has no distinct fallbacks", () => {
    const route: Route = {
      primary: { provider: "zai", model: "m1" },
      fallbacks: [{ provider: "zai", model: "m2" }],
    };
    expect(hedgedCohort(route)).toEqual([{ provider: "zai", model: "m1" }]);
  });
});

describe("runHedgedDelegation", () => {
  it("first success wins, aborts in-flight siblings via the threaded signal, classifies them lost", async () => {
    const cohort: Candidate[] = [
      { provider: "zai", model: "a" },
      { provider: "kimi", model: "b" },
    ];
    const raced = await hedged(cohort, (providerId, signal) => {
      if (providerId === "zai") {
        return Promise.resolve(`${providerId}-result`);
      }
      return deferredAbortable(signal, providerId);
    });
    expect(raced.result).toBe("zai-result");
    expect(raced.provider).toBe("zai");
    expect(raced.race.winner).toBe("zai");
    expect(raced.race.lost).toEqual(["kimi"]);
    expect(raced.race.failed).toEqual([]);
  });

  it("rethrows the PRIMARY member's error when every member fails", async () => {
    const cohort: Candidate[] = [
      { provider: "zai", model: "a" },
      { provider: "kimi", model: "b" },
    ];
    await expect(
      hedged(cohort, (providerId) => {
        throw new Error(providerId === "zai" ? "primary boom" : "secondary boom");
      }),
    ).rejects.toThrow("primary boom");
  });

  it("classifies a sibling that failed on its own (non-abort error) as failed, not lost", async () => {
    const cohort: Candidate[] = [
      { provider: "zai", model: "a" },
      { provider: "kimi", model: "b" },
    ];
    const raced = await hedged(cohort, (providerId, signal) => {
      if (providerId === "zai") {
        return Promise.resolve("zai-ok");
      }
      // kimi rejects immediately with its OWN 503 error — independent of the race abort.
      void signal;
      return Promise.reject(new Error("HTTP 503 service unavailable"));
    });
    expect(raced.race.winner).toBe("zai");
    expect(raced.race.failed).toEqual(["kimi"]);
  });

  it("parent abort propagates to all members", async () => {
    const parent = new AbortController();
    const cohort: Candidate[] = [
      { provider: "zai", model: "a" },
      { provider: "kimi", model: "b" },
    ];
    const promise = runHedgedDelegation<string>({
      cfg: undefined,
      cohort,
      resolveApiKeyForProvider: authResolver,
      parentSignal: parent.signal,
      run: (_client, _model, providerId, signal) => deferredAbortable(signal, providerId),
    });
    setTimeout(() => parent.abort(), 5);
    await expect(promise).rejects.toThrow(/aborted/);
  });
});
