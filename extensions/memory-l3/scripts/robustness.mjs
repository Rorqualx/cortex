// Robustness bar helpers (ARCH-2, 2026-10-12): interface-sensitivity
// measurement for LLM-judged metrics — the same sampled answers judged by
// every judge variant; the max pairwise accuracy delta is the bar. Exported
// surface (probe amendment A3): maxPairwiseDelta + renderRobustnessBar +
// computeRobustnessBar(sample, judge). The embedder-variant axis (design
// §C.1 second half) is a documented DEFERRED follow-up: it needs per-embedder
// regeneration in the engine runner, not scorer scope.
//
// Lives in scripts/ beside the scorer (no src/ runtime code depends on it);
// the unit test lives at ../src/robustness.test.ts so the vitest project
// glob picks it up.

export function maxPairwiseDelta(accs) {
  if (!Array.isArray(accs) || accs.length < 2) {
    return 0;
  }
  let max = 0;
  for (let i = 0; i < accs.length; i += 1) {
    for (let j = i + 1; j < accs.length; j += 1) {
      max = Math.max(max, Math.abs(accs[i] - accs[j]));
    }
  }
  return max;
}

export function renderRobustnessBar({ accuracy, maxDelta, variants, sampled }) {
  const pct = Math.round(accuracy * 100);
  const deltaPct = Math.round(maxDelta * 100);
  return `accuracy = ${pct}% ± ${deltaPct}% (interface-sensitivity bar, ${variants} variants, ${sampled} sampled)`;
}

/**
 * Judge the SAME sampled items with every variant (primary first) and report
 * per-variant accuracy plus the max pairwise delta. `judge(item, model)`
 * returns true/false/null (verdict/unparseable). Exactly items × variants
 * judge invocations — no hidden retries here. Degrades to {status:"skipped"}
 * when no SECONDARY judge is configured (a single-variant bar is meaningless),
 * never throws.
 */
export async function computeRobustnessBar({ sample, primaryModel, secondaryModels, judge }) {
  if (!Array.isArray(secondaryModels) || secondaryModels.length === 0) {
    return {
      status: "skipped",
      render: "robustness: SKIPPED (no secondary judge configured)",
    };
  }
  const variants = [primaryModel, ...secondaryModels];
  const rows = [];
  for (const model of variants) {
    let judged = 0;
    let correct = 0;
    for (const item of sample) {
      const verdict = await judge(item, model);
      if (verdict === true) {
        judged += 1;
        correct += 1;
      } else if (verdict === false) {
        judged += 1;
      }
      // null (unparseable) is not judged — matches scorer verdict accounting.
    }
    rows.push({
      variant: model,
      model,
      judged,
      correct,
      accuracy: judged > 0 ? correct / judged : 0,
    });
  }
  const maxDelta = maxPairwiseDelta(rows.map((r) => r.accuracy));
  return {
    status: "ok",
    rows,
    maxDelta,
    render: renderRobustnessBar({
      accuracy: rows[0].accuracy,
      maxDelta,
      variants: variants.length,
      sampled: sample.length,
    }),
  };
}
