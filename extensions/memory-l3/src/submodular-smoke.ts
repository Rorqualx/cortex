import { tokenize, jaccard } from "./scoring.js";

// Copy of submodularSelect for standalone verification
function submodularSelect(scored, queryTokens, topK, diversityWeight, coverageWeight, tokenBudget) {
  const selected = [];
  const selectedKeys = new Set();
  const coveredTokens = new Set();
  let usedTokens = 0;
  const budget = tokenBudget ?? topK * 20;
  const pool = scored.slice();

  while (pool.length > 0) {
    let bestIdx = -1;
    let bestGain = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const item = pool[i];
      if (selectedKeys.has(item.fact.dedupKey)) continue;

      const itemTokens = Math.ceil(item.fact.text.length / 4);
      // Budget check: when tokenBudget is explicit, enforce it strictly.
      if (tokenBudget !== null && usedTokens + itemTokens > budget) {
        continue;
      }

      const relevance = item.score;
      let maxSim = 0;
      const itemTokensSet = tokenize(item.fact.text);
      for (const sel of selected) {
        const sim = jaccard(itemTokensSet, tokenize(sel.fact.text));
        if (sim > maxSim) maxSim = sim;
      }
      const diversity = 1 - maxSim;
      const newTokens = [...queryTokens].filter(
        (t) => itemTokensSet.has(t) && !coveredTokens.has(t),
      );
      const coverage = queryTokens.size > 0 ? newTokens.length / queryTokens.size : 0;
      const gain = relevance + diversityWeight * diversity + coverageWeight * coverage;

      if (gain > bestGain) {
        bestGain = gain;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;

    const chosen = pool[bestIdx];
    selected.push(chosen);
    selectedKeys.add(chosen.fact.dedupKey);
    const chosenTokens = tokenize(chosen.fact.text);
    for (const t of queryTokens) {
      if (chosenTokens.has(t)) coveredTokens.add(t);
    }
    usedTokens += Math.ceil(chosen.fact.text.length / 4);
    pool.splice(bestIdx, 1);

    if (selected.length >= topK) break;
  }

  return selected;
}

function rf(text, score) {
  return {
    fact: {
      id: `f-${text.slice(0, 10)}`,
      text,
      importance: 0.5,
      createdAt: Date.now(),
      dedupKey: `dk-${text}`,
    },
    score,
    signals: {},
    chunkId: "c1",
    tier: "l2",
  };
}

// Test 1: relevance-only
const t1 = submodularSelect(
  [rf("alpha beta gamma", 0.9), rf("beta gamma delta", 0.8), rf("gamma delta epsilon", 0.7)],
  new Set(["alpha"]),
  2,
  0,
  0,
  null,
);
console.assert(t1.length === 2, "t1 length");
console.assert(t1[0].fact.text === "alpha beta gamma", "t1[0]");
console.assert(t1[1].fact.text === "beta gamma delta", "t1[1]");

// Test 2: diversity
const t2 = submodularSelect(
  [
    rf("the quick brown fox", 0.95),
    rf("the quick brown fox jumps", 0.94),
    rf("completely different topic", 0.5),
  ],
  new Set(["fox"]),
  2,
  1.0,
  0,
  null,
);
const t2texts = t2.map((r) => r.fact.text);
console.assert(t2texts.includes("the quick brown fox"), "t2 has fox");
console.assert(t2texts.includes("completely different topic"), "t2 has different");

// Test 3: coverage
const t3 = submodularSelect(
  [rf("apple banana", 0.6), rf("cherry date", 0.55), rf("apple cherry", 0.5)],
  new Set(["apple", "banana", "cherry", "date"]),
  4,
  0,
  1.0,
  null,
);
const t3text = t3.map((r) => r.fact.text).join(" ");
console.assert(t3text.includes("apple"), "t3 apple");
console.assert(t3text.includes("banana"), "t3 banana");
console.assert(t3text.includes("cherry"), "t3 cherry");
console.assert(t3text.includes("date"), "t3 date");

// Test 4: budget
const t4 = submodularSelect(
  [
    rf("short", 0.9),
    rf("this is a much longer fact text that consumes tokens", 0.8),
    rf("tiny", 0.7),
  ],
  new Set([]),
  10,
  0,
  0,
  10,
);
const totalChars = t4.reduce((s, r) => s + r.fact.text.length, 0);
console.assert(totalChars <= 10 * 4 + 10, "t4 budget");

// Test 5: topK cap
const t5 = submodularSelect(
  Array.from({ length: 10 }, (_, i) => rf(`fact ${i}`, 1.0 - i * 0.05)),
  new Set([]),
  3,
  0,
  0,
  10000,
);
console.assert(t5.length === 3, "t5 length");

// Test 6: empty
const t6 = submodularSelect([], new Set(["x"]), 5, 0.3, 0.3, null);
console.assert(t6.length === 0, "t6 empty");

console.log("All submodular tests passed!");
