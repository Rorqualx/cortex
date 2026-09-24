// THROWAWAY PROBE — card 27d4c174 (ARCH-1: fact-graph dependency edges in L3)
// Validates on a COPY of the live store (/tmp/probe-edges-l3.sqlite):
//   1. l3_fact_edges DDL (additive, row-keyed upsert) + idempotent INSERT OR REPLACE
//   2. `supersedes` edge volume from real supersession history (history[] entries)
//   3. `entity-shares` candidate volume via replicated deterministic entity heuristics
//      (IP / URL-host / path-basename patterns from entities.ts), Jaccard >= 0.3 gate,
//      per-entity pair cap 8, singleton buckets skipped
//   4. Bulk write timing + integrity_check
// No repo imports. node >= 22 (node:sqlite).
import { DatabaseSync } from "node:sqlite";

const DB = "/tmp/probe-edges-l3.sqlite";
const out = (label, val) => console.log(`${label}: ${JSON.stringify(val)}`);

const db = new DatabaseSync(DB);
const kv = (k) => db.prepare("SELECT value FROM l3_kv WHERE key = ?").get(k)?.value ?? null;

// ---------- 1. Load typed facts (shape-introspecting) ----------
const rawTyped = kv("longterm_typed");
if (!rawTyped) throw new Error("no longterm_typed blob");
const typedDoc = JSON.parse(rawTyped);
const facts =
  typedDoc.typedFacts ?? typedDoc.facts ?? (Array.isArray(typedDoc) ? typedDoc : null);
if (!facts) {
  out("typedDoc keys", Object.keys(typedDoc));
  throw new Error("could not locate facts array — inspect keys above");
}
const unarchived = facts.filter((f) => !f.archived);
const archived = facts.filter((f) => f.archived);
out("typed facts total/unarchived/archived", [facts.length, unarchived.length, archived.length]);
out("fact has dedupKey", `${facts.filter((f) => typeof f.dedupKey === "string" && f.dedupKey).length}/${facts.length}`);
out("sample dedupKeys", unarchived.slice(0, 3).map((f) => f.dedupKey));
out("sample slots", unarchived.slice(0, 3).map((f) => f.slot));

// ---------- 2. supersedes volume from real history ----------
let supersedeEvents = 0;
let factsWithHistory = 0;
for (const f of facts) {
  const h = Array.isArray(f.history) ? f.history.length : 0;
  if (h > 0) factsWithHistory++;
  supersedeEvents += h;
}
out("facts carrying history", factsWithHistory);
out("supersedes edges WOULD-have-emitted (conf 1.0)", supersedeEvents);

// ---------- 3. entity-shares simulation ----------
// Replicated deterministic heuristics from entities.ts extractEntitiesFromFacts
// (the subset that applies to typed fact values): IPs, URL hosts, path basenames.
const entitiesOf = (f) => {
  const ents = new Set();
  const v = String(f.value ?? "");
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(v)) ents.add("ip:" + v.split(/\s|\/|:/)[0]);
  if (/^https?:\/\//.test(v)) {
    try { ents.add("host:" + new URL(v).hostname); } catch { /* ignore */ }
  }
  const slot = String(f.slot ?? "");
  if (slot.includes("path") || slot.includes("dir") || slot.includes("repo")) {
    const base = v.split("/").pop();
    if (base && base.length > 1) ents.add("proj:" + base.toLowerCase());
  }
  return [...ents];
};

const factEnts = new Map(); // dedupKey -> entity set
const buckets = new Map(); // entity -> [dedupKey]
for (const f of unarchived) {
  const ents = entitiesOf(f);
  if (ents.length === 0 || !f.dedupKey) continue;
  factEnts.set(f.dedupKey, new Set(ents));
  for (const e of ents) {
    if (!buckets.has(e)) buckets.set(e, []);
    buckets.get(e).push(f.dedupKey);
  }
}
const bucketSizes = [...buckets.values()].map((a) => a.length).sort((a, b) => b - a);
out("facts with >=1 entity", factEnts.size);
out("entity buckets", buckets.size);
out("singleton buckets (skipped)", bucketSizes.filter((s) => s === 1).length);
out("top-5 bucket sizes", bucketSizes.slice(0, 5));

const jaccard = (a, b) => {
  const i = [...a].filter((x) => b.has(x)).length;
  const u = a.size + b.size - i;
  return u === 0 ? 0 : i / u;
};

// Pairwise within multi-fact buckets, undirected dedup, per-entity cap 8, J>=0.3
const emitted = new Map(); // "a|b" (sorted) -> Set(entity causes, capped implicitly by pair)
const perEntityPairs = new Map();
const jacSpread = { ge03: 0, lt03: 0 };
for (const [ent, members] of buckets) {
  if (members.length < 2) continue;
  let pairsForEntity = 0;
  outer: for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (perEntityPairs.get(ent) >= 8) break outer;
      const a = members[i], b = members[j];
      if (a === b) continue;
      const jv = jaccard(factEnts.get(a), factEnts.get(b));
      if (jv < 0.3) { jacSpread.lt03++; continue; }
      jacSpread.ge03++;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!emitted.has(key)) emitted.set(key, new Set());
      if (!emitted.get(key).has(ent)) {
        emitted.get(key).add(ent);
        perEntityPairs.set(ent, (perEntityPairs.get(ent) ?? 0) + 1);
        pairsForEntity++;
      }
    }
  }
  perEntityPairs.set(ent, Math.min(perEntityPairs.get(ent) ?? 0, 8));
}
out("entity-shares edges WOULD-emit (J>=0.3, cap8, unique pairs)", emitted.size);
out("jaccard spread pairs", jacSpread);

// ---------- 4. DDL + upsert idempotency + bulk write on the copy ----------
db.exec(`CREATE TABLE IF NOT EXISTS l3_fact_edges (
  source_key TEXT NOT NULL,
  target_key TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_epoch INTEGER NOT NULL,
  PRIMARY KEY (source_key, target_key, edge_type)
);`);
out("DDL l3_fact_edges", "created (additive, existing tables untouched)");

const up = db.prepare(
  "INSERT OR REPLACE INTO l3_fact_edges (source_key, target_key, edge_type, confidence, created_epoch) VALUES (?, ?, ?, ?, ?)"
);
db.exec("BEGIN IMMEDIATE");
up.run("dk-A", "dk-B", "supersedes", 1.0, 900);
up.run("dk-A", "dk-B", "supersedes", 1.0, 901); // same PK -> replace
up.run("dk-A", "dk-B", "supersedes", 1.0, 902);
db.exec("COMMIT");
const idem = db.prepare("SELECT count(*) n FROM l3_fact_edges").get().n;
out("upsert idempotency (3 writes same PK -> rows)", idem);

// bulk write the measured edge volume, timed
const now = Date.now();
const epoch = 900;
const edges = [
  ...[...emitted.keys()].map((k) => {
    const [s, t] = k.split("|");
    return [s, t, "entity-shares", 0.5, epoch];
  }),
];
db.exec("BEGIN IMMEDIATE");
for (const e of edges) up.run(...e);
db.exec("COMMIT");
const bulkMs = Date.now() - now;
out("bulk entity-shares write", `${edges.length} rows in ${bulkMs}ms`);

const total = db.prepare("SELECT count(*) n FROM l3_fact_edges").get().n;
const byType = db
  .prepare("SELECT edge_type, count(*) n FROM l3_fact_edges GROUP BY edge_type")
  .all();
out("total rows in l3_fact_edges", total);
out("rows by type", byType);
const integ = db.prepare("PRAGMA integrity_check").get();
out("integrity_check", integ);
db.close();
out("PROBE RESULT", "OK");
