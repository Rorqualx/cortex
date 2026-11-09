/**
 * PROBE (throwaway) — ARCH-1 Two-Phase Sleep Consolidation feasibility spike.
 * Card f09d365e. Validates the 2026-11-07 plan's three probe questions:
 *   (i)   flag-OFF afterTurn run byte-identical to pre-change baseline
 *   (ii)  flag-ON run with 2-fact promotion writes `phases` + grows edge map
 *   (iii) promotedFacts threading compiles against the real return shape
 *
 * Modes (env SPIKE_MODE): baseline | off | on
 *   baseline — clean tree: run scenario, sanity-assert epoch exists, dump DB.
 *   off      — patched tree, flag unset: run, dump; byte-compare vs SPIKE_BASELINE.
 *   on       — patched tree, OPENCLAW_MEMORY_L3_TWO_PHASE=1: run, assert phases+edges.
 *
 * Dump: every sqlite table (normalized: uuids → <uuid>, ltt-ids → <ltt>, temp root → <root>).
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HierarchicalL3Engine } from "../../src/engine.js";
import { Storage } from "../../src/storage.js";
import type { LlmCaller } from "../../src/llm.js";

const MODE = process.env.SPIKE_MODE ?? "baseline";
const FIXED = 1_794_157_200_000; // 2026-11-08T10:00:00Z — deterministic clock
const TURNS = 5;

// Deterministic fake caller: same 2 typed facts + 2 prose facts on every
// extraction call, regardless of prompt. Garbage-for-consolidution prompts
// (consolidate/reconcile) fail their own parses non-fatally — same paths in
// every run, so determinism holds.
const FAKE_JSON = JSON.stringify({
  facts: [
    { text: "The greenhouse uses a rammed-earth north wall", importance: 0.9, dedupKey: "greenhouse-wall", certainty: "confirmed" },
    { text: "HueyTheDestroyer runs the Docker stack", importance: 0.8, dedupKey: "docker-host", certainty: "confirmed" },
  ],
  typedFacts: [
    { slot: "greenhouse_depth_m", value: "2.4", sourceSpan: "the greenhouse is dug 2.4m deep", unit: "m", confidence: 0.95 },
    { slot: "docker_host_ip", value: "192.168.50.185", sourceSpan: "docker host is at 192.168.50.185", unit: null, confidence: 0.95 },
  ],
  decisions: [],
  actions: [],
  activeConstraints: [],
});

function filler(seed: number, minChars: number): string {
  let out = "";
  let x = (seed * 2654435761) % 2147483647;
  while (out.length < minChars) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += `ctx-${seed}-${x.toString(36)} `;
  }
  return out;
}

function buildSession() {
  // Full session array grows by 2 messages per turn (runtime contract:
  // afterTurn receives the whole session each time). Each turn's user
  // message ≈ 18k chars ≈ 4.5k est-tokens > 4000 threshold → one
  // compaction per turn → ≥5 chunks → epoch boundary at chunk idx 4.
  const messages: Array<{ role: "user" | "assistant"; content: unknown; timestamp: number }> = [];
  const turns: Array<typeof messages> = [];
  for (let t = 0; t < TURNS; t++) {
    messages.push({
      role: "user",
      content: `Turn ${t}: the greenhouse is dug 2.4m deep and the docker host is at 192.168.50.185. ${filler(t + 1, 18000)}`,
      timestamp: FIXED + t * 60_000,
    });
    messages.push({
      role: "assistant",
      content: [{ type: "text" as const, text: `ack-${t}` }],
      timestamp: FIXED + t * 60_000 + 1_000,
    });
    turns.push([...messages]);
  }
  return turns;
}

function normalize(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\boc-vt-[a-z0-9]{6}\b/gi, "<agent-id>")
    .replace(/\bchunk-\d{6}-[0-9a-f]{8}\b/gi, "<chunk-id>")
    .replace(/\b(?:ltt|lt|tf|fact)-[0-9a-f]{8}\b/gi, "<obj-id>");
}

function findDbFile(root: string): string {
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) queue.push(p);
      else if (name.endsWith(".sqlite") || name.endsWith(".sqlite3") || name.endsWith(".db")) return p;
    }
  }
  throw new Error("no sqlite file under " + root);
}

function dumpDb(root: string): { dump: string; epochs: Array<{ id: string; frontmatter: any; body: string }>; edgeCount: number } {
  const dbPath = findDbFile(root);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);
    const tableDumps: Record<string, unknown[]> = {};
    for (const t of tables) {
      try {
        tableDumps[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
      } catch {
        tableDumps[t] = [{ error: "unreadable" }];
      }
    }
    let epochs: Array<{ id: string; frontmatter: any; body: string }> = [];
    try {
      epochs = (
        db.prepare("SELECT id, frontmatter, body FROM l3_epochs ORDER BY id").all() as Array<{ id: string; frontmatter: string; body: string }>
      ).map((r) => ({ id: r.id, frontmatter: JSON.parse(r.frontmatter), body: r.body }));
    } catch {
      /* no l3_epochs table */
    }
    let edgeCount = 0;
    try {
      edgeCount = (db.prepare("SELECT COUNT(*) AS n FROM l3_edges").get() as { n: number }).n;
    } catch {
      /* no l3_edges table */
    }
    const dump = normalize(JSON.stringify(tableDumps, null, 1)).split(root).join("<root>");
    return { dump, epochs, edgeCount };
  } finally {
    db.close();
  }
}

describe(`two-phase spike [mode=${MODE}]`, () => {
  let root: string;
  let engine: HierarchicalL3Engine;

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    root = mkdtempSync(path.join(tmpdir(), "l3-two-phase-spike-"));
    const storage = new Storage(root);
    const caller: LlmCaller = async () => FAKE_JSON;
    engine = new HierarchicalL3Engine(storage, { caller, agentDir: root });
  });

  afterAll(() => {
    vi.useRealTimers();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("runs the deterministic 5-turn scenario and reaches an epoch boundary", { timeout: 120_000 }, async () => {
    if (MODE === "on") process.env.OPENCLAW_MEMORY_L3_TWO_PHASE = "1";
    await engine.bootstrap();
    const turns = buildSession();
    for (let t = 0; t < turns.length; t++) {
      vi.setSystemTime(FIXED + t * 60_000);
      await engine.afterTurn({
        sessionId: "spike-session",
        sessionFile: path.join(root, "session.jsonl"),
        messages: turns[t] as any,
        prePromptMessageCount: 0,
      });
    }
    const { dump, epochs, edgeCount } = dumpDb(root);
    expect(epochs.length).toBeGreaterThanOrEqual(1);
    const epoch0 = epochs.find((e) => e.id === "epoch-0000");
    expect(epoch0).toBeDefined();

    if (process.env.SPIKE_OUT) {
      writeFileSync(
        process.env.SPIKE_OUT,
        JSON.stringify({ dump, epochs: epochs.map((e) => normalize(JSON.stringify(e))), edgeCount }, null, 1),
      );
    }

    if (MODE === "off" && process.env.SPIKE_BASELINE) {
      const base = JSON.parse(readFileSync(process.env.SPIKE_BASELINE, "utf8")) as { dump: string };
      expect(dump).toBe(base.dump); // CORE: flag OFF ⇒ byte-identical to pre-change baseline
    }

    if (MODE === "on") {
      // (iii)+(ii): phases present, additive-only vs baseline, edges grew.
      const phases = (epoch0 as { frontmatter: { phases?: any } }).frontmatter.phases;
      expect(phases).toBeDefined();
      expect(phases.nrem.promoted).toBeGreaterThanOrEqual(1);
      expect(phases.rem.edgesAdded).toBeGreaterThanOrEqual(1);
      if (process.env.SPIKE_BASELINE) {
        const base = JSON.parse(readFileSync(process.env.SPIKE_BASELINE, "utf8")) as {
          dump: string;
          edgeCount: number;
          epochs: string[];
        };
        expect(edgeCount).toBeGreaterThan(base.edgeCount);
        // additive-only: ON frontmatter minus `phases` ≡ baseline epoch-0000 frontmatter
        const stripped = { ...(epoch0 as any).frontmatter };
        delete stripped.phases;
        const baseEpoch0 = JSON.parse(base.epochs[0]);
        expect(normalize(JSON.stringify(stripped))).toBe(normalize(JSON.stringify(baseEpoch0.frontmatter)));
      }
    }
  });
});
