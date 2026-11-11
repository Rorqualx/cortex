// Deep-pipeline card selector: read-only query over gateway state DB.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("/Users/joederas/.openclaw/state/openclaw.sqlite", { readOnly: true });
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((t) => t.name);
console.log("workboard-ish tables:", tables.filter((t) => /work|card|board/i.test(t)).join(", ") || "(none)");
console.log("workboard_cards count:", db.prepare(`SELECT COUNT(*) c FROM workboard_cards`).get().c);

const rows = db.prepare(`SELECT id, data FROM workboard_cards`).all();
const order = ["research", "rescope", "design", "plan", "probe", "test", "review", "implement"];
const terminal = new Set(["implement", "ready", "done", "blocked"]);
const out = [];
for (const { id, data } of rows) {
  let c;
  try {
    c = JSON.parse(data);
  } catch {
    continue;
  }
  if (c?.card && typeof c.card === "object") c = c.card; // rows are {version, card}
  const r = c.metadata?.research;
  if (!r || !["architecture", "long-horizon"].includes(r.category)) continue;
  out.push({
    id,
    title: (c.title || "").slice(0, 90),
    status: c.status,
    section: c.section,
    position: c.position,
    category: r.category,
    stage: r.stage || null,
    itemId: r.itemId || null,
  });
}
console.log("total arch/LH:", out.length);
out.sort((a, b) => (order.indexOf(a.stage ?? -1) - order.indexOf(b.stage ?? -1)) || (a.position - b.position));
for (const c of out) console.log(`stage=${c.stage}\tstatus=${c.status}\tpos=${c.position}\t${c.category}\t${c.itemId}\t${c.id}\t${c.title}`);

console.log("--- QUALIFYING (in-flight before new; arch before LH; by position):");
const qual = out
  .filter((c) => c.stage && !terminal.has(c.stage) && !["done", "blocked", "ready"].includes(c.status))
  .sort((a, b) =>
    (a.stage !== "research" ? 0 : 1) - (b.stage !== "research" ? 0 : 1) ||
    (a.category === "architecture" ? 0 : 1) - (b.category === "architecture" ? 0 : 1) ||
    a.position - b.position
  );
for (const c of qual) console.log(`stage=${c.stage}\tstatus=${c.status}\tpos=${c.position}\t${c.category}\t${c.itemId}\t${c.id}\t${c.title}`);
