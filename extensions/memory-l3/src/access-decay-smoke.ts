// Smoke test for RW-1: Access-time decay for L3 typed facts

function typedFactAccessDecay(confidence, lastAccessedAt, now) {
  const effectiveLastAccess = lastAccessedAt ?? now;
  const ageMs = Math.max(0, now - effectiveLastAccess);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const HALF_LIFE_DAYS = 30;
  return confidence * Math.exp(-ageDays / HALF_LIFE_DAYS);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 4, 6, 12, 0, 0);

// Test 1: No decay when just accessed
const t1 = typedFactAccessDecay(0.9, NOW, NOW);
console.assert(Math.abs(t1 - 0.9) < 0.001, `t1: expected ~0.9, got ${t1}`);

// Test 2: Half decay after 30 days
const t2 = typedFactAccessDecay(0.9, NOW - 30 * MS_PER_DAY, NOW);
console.assert(Math.abs(t2 - 0.9 * Math.exp(-1)) < 0.001, `t2: expected ~0.331, got ${t2}`);

// Test 3: Backward compat: undefined lastAccessedAt -> no decay
const t3 = typedFactAccessDecay(0.9, undefined, NOW);
console.assert(Math.abs(t3 - 0.9) < 0.001, `t3: expected ~0.9, got ${t3}`);

// Test 4: Strong decay after 90 days
const t4 = typedFactAccessDecay(0.9, NOW - 90 * MS_PER_DAY, NOW);
console.assert(t4 < 0.1, `t4: expected <0.1, got ${t4}`);

// Test 5: Zero confidence stays zero
const t5 = typedFactAccessDecay(0, NOW - 30 * MS_PER_DAY, NOW);
console.assert(t5 === 0, `t5: expected 0, got ${t5}`);

console.log("All access-time decay smoke tests passed!");
