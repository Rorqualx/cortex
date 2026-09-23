// THROWAWAY probe v2 — 3c1285b0 observation-clock archival trigger
// Replicates longterm-typed.ts archive-loop guards (old guard-2 vs guard-2′)
// on a /tmp copy of the live l3.sqlite. No build, no vitest.
import { DatabaseSync } from "node:sqlite";

const DB = "/tmp/probe-v2-l3.sqlite";
const MS_DAY = 86_400_000;
const WINDOW = 60 * MS_DAY; // maxAgeWithoutConfirmMs (default)
const STABLE_SKIP = 30 * MS_DAY; // QW-3

const db = new DatabaseSync(DB, { readOnly: true });

// --- 1. canonical typed facts ---
const kv = db.prepare("SELECT value FROM l3_kv WHERE key = ?").get("longterm_typed");
const fm = JSON.parse(kv.value);
const facts = fm.facts;
const now0 = fm.lastConsolidatedAt; // loop's "now" at last consolidation
console.log(`facts=${facts.length} lastConsolidatedAt=${new Date(now0).toISOString()}`);
console.log(`archived=${facts.filter((f) => f.archived).length} active=${facts.filter((f) => !f.archived).length}`);

// --- 2. candidates map (aggregateTypedCandidates latest-tracking) ---
const rows = db.prepare("SELECT id, created_at, frontmatter FROM l3_l2_chunks").all();
const cand = new Map(); // slot -> {latestCreatedAt, obs}
for (const r of rows) {
  const f = JSON.parse(r.frontmatter);
  for (const t of f.typedFacts ?? []) {
    const cur = cand.get(t.slot);
    if (!cur || t.createdAt > cur.latestCreatedAt) {
      cand.set(t.slot, { latestCreatedAt: t.createdAt, obs: t.lastVerifiedAt ?? t.createdAt });
    }
  }
}
console.log(`l2chunks=${rows.length} candidateSlots=${cand.size}`);
const activeFacts = facts.filter((f) => !f.archived);
const candPresent = activeFacts.filter((f) => cand.has(f.slot));
console.log(`activeFactsWithCandidate=${candPresent.length} activeWithoutCandidate=${activeFacts.length - candPresent.length}`);

// --- 3. guard chain replica ---
const skipStable = (f, now) => {
  if (f.volatilityClass !== "stable") return false;
  if ((f.recallCount ?? 0) <= 1) return false;
  return now - (f.lastVerifiedAt ?? f.lastConfirmedAt) < STABLE_SKIP;
};

function simulate(now, cap, guard2prime) {
  const eligible = [];
  let blockedByGuard2 = 0; // old semantics: candidate present => skip
  let protectedFresh = 0; // guard-2': candidate present AND fresh => skip (correct protection)
  let skippedStable = 0, skippedAge = 0;
  for (const f of facts) {
    if (f.archived) continue;
    const c = cand.get(f.slot);
    if (c) {
      if (!guard2prime) { blockedByGuard2++; continue; } // OLD bug
      if (now - c.obs < WINDOW) { protectedFresh++; continue; } // guard-2'
    }
    if (skipStable(f, now)) { skippedStable++; continue; }
    const lastActive = f.lastVerifiedAt ?? f.lastConfirmedAt;
    if (now - lastActive < WINDOW) { skippedAge++; continue; }
    eligible.push({ slot: f.slot, lastActive });
  }
  eligible.sort((a, b) => a.lastActive - b.lastActive); // oldest first
  const applied = cap === 0 ? eligible.length : Math.min(cap, eligible.length);
  return { eligible: eligible.length, applied, blockedByGuard2, protectedFresh, skippedStable, skippedAge };
}

const oldG = simulate(now0, 500, false);
const newG = simulate(now0, 500, true);
console.log("\n--- OLD guard-2 (candidate present => skip) ---");
console.log(JSON.stringify(oldG));
console.log("--- NEW guard-2' (recency-aware), now = lastConsolidatedAt ---");
console.log(JSON.stringify(newG));

// --- 4. stale-stamp analysis on candidate-present slots ---
let staleStamp = 0, freshStamp = 0;
for (const f of activeFacts) {
  const c = cand.get(f.slot);
  if (!c) continue;
  if (now0 - c.obs >= WINDOW) staleStamp++; else freshStamp++;
}
console.log(`\ncandidate-present slots: staleStamp(>=60d, no longer protects)=${staleStamp} freshStamp(<60d)=${freshStamp}`);
const maxCandAge = Math.max(...candPresent.map((f) => now0 - cand.get(f.slot).obs));
console.log(`oldest candidate stamp age: ${(maxCandAge / MS_DAY).toFixed(0)}d`);

// --- 5. clock consistency: reaffirm stamps fact.lastVerifiedAt = candidate obs ---
let same = 0, diverged = 0, examples = [];
for (const f of activeFacts) {
  const c = cand.get(f.slot);
  if (!c || f.lastVerifiedAt == null) continue;
  if (f.lastVerifiedAt === c.obs) same++;
  else { diverged++; if (examples.length < 3) examples.push({ slot: f.slot, factLv: f.lastVerifiedAt, candObs: c.obs }); }
}
console.log(`\nclock consistency fact.lastVerifiedAt === candidate.obs: same=${same} diverged=${diverged}`);
if (examples.length) console.log(JSON.stringify(examples));

// --- 6. drain simulation: 14 daily epochs, cap 500, oldest-first ---
console.log("\n--- drain simulation (guard-2', cap 500/epoch, 1d epochs) ---");
let archivedTotal = 0;
let archivedSet = new Set();
for (let k = 0; k < 14; k++) {
  const now = now0 + k * MS_DAY;
  // re-simulate each epoch with prior archives applied is approximated by
  // tracking archived slots in a set (facts' aging continues; candidates fixed)
  const s = simulateWithSet(now, 500, archivedSet);
  archivedSet = s.newlyArchived;
  archivedTotal += s.applied;
  console.log(`epoch+${k}d eligible=${s.eligible} applied=${s.applied} cumulative=${archivedTotal}`);
}
function simulateWithSet(now, cap, alreadyArchived) {
  const eligible = []; const newlyArchived = new Set(alreadyArchived);
  let protectedFresh = 0;
  for (const f of facts) {
    if (f.archived || alreadyArchived.has(f.slot)) continue;
    const c = cand.get(f.slot);
    if (c && now - c.obs < WINDOW) { protectedFresh++; continue; }
    if (skipStable(f, now)) continue;
    const lastActive = f.lastVerifiedAt ?? f.lastConfirmedAt;
    if (now - lastActive < WINDOW) continue;
    eligible.push({ slot: f.slot, lastActive });
  }
  eligible.sort((a, b) => a.lastActive - b.lastActive);
  const applied = cap === 0 ? eligible.length : Math.min(cap, eligible.length);
  for (let i = 0; i < applied; i++) newlyArchived.add(eligible[i].slot);
  return { eligible: eligible.length, applied, newlyArchived, protectedFresh };
}
