/**
 * PROBE (3c1285b0) — self-contained spike (plain node, zero repo imports).
 *
 * The worktree node_modules (Sep 7) is older than current sources: the tsx
 * import chain into src/ breaks on missing hoisted links and stale workspace
 * packages. This probe therefore talks to the l3_kv blobs directly with
 * node:sqlite, mirroring storage.ts's exact read/write mechanics
 * (readKv: SELECT value FROM l3_kv WHERE key=?; writeKv: INSERT OR REPLACE
 * under BEGIN IMMEDIATE — storage.ts:649-663).
 *
 * Plan probe-handoff questions, against a COPY of the live l3.sqlite:
 *   (a) candidate scan + attribution of the 0-archived-live anomaly
 *   (b) synthesize backdated archivedAt → dry-run / export / purge / vacuum
 *   (c) blob integrity + VACUUM duration at realistic size
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const LIVE_ROOT = process.env.L3_PROBE_ROOT ?? "/Users/joederas/.openclaw/workspace/.openclaw/l3";
const DAY = 24 * 3600 * 1000;
const KV_TYPED = "longterm_typed";
const KV_PROSE = "longterm";

function snapshotLiveStore() {
  const tmp = mkdtempSync(join(tmpdir(), "l3-reclaim-probe-"));
  for (const suffix of ["l3.sqlite", "l3.sqlite-wal", "l3.sqlite-shm"]) {
    const src = join(LIVE_ROOT, suffix);
    if (existsSync(src)) cpSync(src, join(tmp, suffix));
  }
  return tmp;
}

const readKv = (db, key) => {
  const row = db.prepare("SELECT value FROM l3_kv WHERE key = ?").get(key);
  return row ? row.value : null;
};
const writeKv = (db, key, value) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT OR REPLACE INTO l3_kv (key, value) VALUES (?, ?)").run(key, value);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
};

function stableSkip(fact, now, stableSkipAgeMs = 30 * DAY) {
  if (fact.volatilityClass !== "stable") return false;
  if ((fact.recallCount ?? 0) <= 1) return false;
  const lastVerified = fact.lastVerifiedAt ?? fact.lastConfirmedAt ?? 0;
  return now - lastVerified < stableSkipAgeMs;
}

const db = (() => {
  assert.ok(existsSync(join(LIVE_ROOT, "l3.sqlite")), `live store not found at ${LIVE_ROOT}`);
  const root = snapshotLiveStore();
  const dbPath = join(root, "l3.sqlite");
  const d = new DatabaseSync(dbPath);
  d.exec("PRAGMA busy_timeout = 5000");
  return { d, dbPath, root };
})();

try {
  const now = Date.now();

  // ---------- (a) candidate scan + anomaly attribution ----------
  const typed = JSON.parse(readKv(db.d, KV_TYPED));
  const prose = JSON.parse(readKv(db.d, KV_PROSE));

  const ageOf = (f) => {
    const last = f.lastVerifiedAt ?? f.lastConfirmedAt ?? null;
    return last === null ? null : (now - last) / DAY;
  };

  const summarize = (facts, label) => {
    const archived = facts.filter((f) => f.archived);
    const legacyNoTs = archived.filter((f) => f.archivedAt === null);
    const buckets = { lt7d: 0, d7_30: 0, d30_60: 0, d60_90: 0, gt90d: 0, noTimestamp: 0 };
    for (const f of facts) {
      const a = ageOf(f);
      if (a === null) buckets.noTimestamp += 1;
      else if (a < 7) buckets.lt7d += 1;
      else if (a < 30) buckets.d7_30 += 1;
      else if (a < 60) buckets.d30_60 += 1;
      else if (a < 90) buckets.d60_90 += 1;
      else buckets.gt90d += 1;
    }
    const wouldArchive = facts.filter(
      (f) => !f.archived && ageOf(f) !== null && ageOf(f) >= 60 && !stableSkip(f, now),
    );
    const skippedStable = facts.filter((f) => !f.archived && stableSkip(f, now)).length;
    console.log(
      `[scan:${label}] total=${facts.length} archived=${archived.length} legacyNoTs=${legacyNoTs.length} skippedStable=${skippedStable} wouldArchiveNow=${wouldArchive.length} ageBuckets=${JSON.stringify(buckets)}`,
    );
    return { facts, wouldArchive };
  };

  summarize(prose.facts ?? [], "prose");
  const t = summarize(typed.facts ?? [], "typed");
  const tf = typed.facts;
  console.log(`[scan] store sqlite size = ${(statSync(db.dbPath).length / 1024 / 1024).toFixed(1)} MB (file only)`);

  const over60 = tf.filter((f) => ageOf(f) !== null && ageOf(f) >= 60);
  const over60StableSkip = over60.filter((f) => stableSkip(f, now));
  const over60Eligible = over60.filter((f) => !f.archived && !stableSkip(f, now));
  console.log(
    `[anomaly] typed over-60d=${over60.length}; stableSkip=${over60StableSkip.length}; eligible-but-not-archived=${over60Eligible.length}; alreadyArchived=${over60.filter((f) => f.archived).length}`,
  );
  assert.ok(tf.length > 0, "typed store is empty — probe needs a populated store");

  // ---------- (b) synthesize backdated archivedAt on the copy ----------
  const toSynthesize = new Set(
    tf.map((f, i) => ({ f, i })).filter(({ f }) => !f.archived).slice(0, 30).map(({ i }) => i),
  );
  assert.ok(toSynthesize.size > 0, "no active facts to synthesize on");
  const fm2 = {
    ...typed,
    facts: tf.map((f, i) => (toSynthesize.has(i) ? { ...f, archived: true, archivedAt: now - 120 * DAY } : f)),
  };
  const writeStart = Date.now();
  writeKv(db.d, KV_TYPED, JSON.stringify(fm2));
  console.log(`[synth] wrote ${toSynthesize.size} backdated-archived facts (INSERT OR REPLACE under BEGIN IMMEDIATE) in ${Date.now() - writeStart}ms`);

  // ---------- dry-run scan (read-only) ----------
  const dryStart = Date.now();
  const after = JSON.parse(readKv(db.d, KV_TYPED));
  const retentionMs = 90 * DAY;
  const candidates = after.facts
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.archived === true && f.archivedAt !== null && now - f.archivedAt > retentionMs);
  console.log(`[dry-run] candidates=${candidates.length} (scan took ${Date.now() - dryStart}ms)`);
  assert.equal(candidates.length, toSynthesize.size, "candidate rule mismatch vs synthesized set");

  // ---------- export before purge ----------
  const exportPath = join(db.root, "purge-archive.jsonl");
  const exportStart = Date.now();
  const lines = candidates.map(({ f, i }) =>
    JSON.stringify({ kind: "typed", index: i, archivedAt: f.archivedAt, purgedAt: now, fact: f }),
  );
  writeFileSync(exportPath, lines.join("\n") + "\n");
  console.log(`[export] ${lines.length} lines → purge-archive.jsonl (${Date.now() - exportStart}ms)`);

  // ---------- purge (blob surgery, storage.ts writeKv mechanics) ----------
  const purgeStart = Date.now();
  const keptIdx = new Set(candidates.map((c) => c.i));
  const purgedFm = { ...after, facts: after.facts.filter((_, i) => !keptIdx.has(i)) };
  writeKv(db.d, KV_TYPED, JSON.stringify(purgedFm));
  console.log(`[purge] blob rewrite in ${Date.now() - purgeStart}ms (${after.facts.length} → ${purgedFm.facts.length} facts)`);

  // ---------- integrity ----------
  const reloaded = JSON.parse(readKv(db.d, KV_TYPED));
  const survivors = after.facts.filter((_, i) => !keptIdx.has(i));
  assert.equal(reloaded.facts.length, after.facts.length - candidates.length);
  assert.equal(JSON.stringify(reloaded.facts), JSON.stringify(survivors), "survivors must be byte-identical");
  const parsedExport = readFileSync(exportPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(parsedExport.length, candidates.length);
  assert.ok(parsedExport.every((e) => e.fact.archivedAt !== null));
  const proseUntouched = JSON.parse(readKv(db.d, KV_PROSE));
  assert.equal(JSON.stringify(proseUntouched), JSON.stringify(prose), "prose blob must be untouched by a typed-only purge");

  // ---------- vacuum outside any transaction ----------
  db.d.close();
  const walPath = `${db.dbPath}-wal`;
  const sizeBefore = statSync(db.dbPath).length + (existsSync(walPath) ? statSync(walPath).length : 0);
  const vacuumDb = new DatabaseSync(db.dbPath);
  const vacuumStart = Date.now();
  vacuumDb.exec("VACUUM");
  const vacuumMs = Date.now() - vacuumStart;
  const sizeAfter = statSync(db.dbPath).length;
  vacuumDb.close();
  console.log(`[vacuum] took ${vacuumMs}ms; logical size ${(sizeBefore / 1024 / 1024).toFixed(1)}MB → file ${(sizeAfter / 1024 / 1024).toFixed(1)}MB`);

  const integrity = new DatabaseSync(db.dbPath);
  const check = integrity.prepare("PRAGMA integrity_check").get();
  integrity.close();
  assert.equal(check.integrity_check, "ok");

  console.log("[probe] ALL PASS");
} catch (err) {
  console.error("[probe] FAILED:", err);
  process.exit(1);
} finally {
  try { db.d.close(); } catch {}
}
