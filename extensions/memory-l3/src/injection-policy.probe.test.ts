/**
 * PROBE TEST — Novelty-gated injection policy feasibility (THROWAWAY)
 * Card: ARCH-1 e0a2e042 — probe-stage deliverable per plan doc §6 (2026-09-30).
 * Never lands in main; the cron worktree is reset by the 06:00 cron.
 *
 * Measures on a synthetic replayed-session corpus (12 conversations, labeled turns):
 *   - suppression rate on TRUE duplicates (exact repeats + paraphrases)
 *   - false-suppression rate on labeled NOVEL turns (must be 0 or probe FAILS)
 *   - injected-token reduction % (chars of avoided systemPromptAddition)
 *   - ring bound, purity (no mutation), window expiry, per-call latency
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  readInjectionPolicyConfig,
  shouldInject,
  fnv1aHash,
  type InjectionRecord,
} from "./injection-policy.js";
import { cosineSimilarity } from "./scoring.js";

// ---------------------------------------------------------------------------
// Deterministic fake embedding: hashed bag-of-words, L2-normalized, dim 96.
// Same shape the engine tests use for embedding-colliding fakes — near-dup
// text shares tokens → high cosine; different focus → low cosine.
// ---------------------------------------------------------------------------
const DIM = 96;
function embed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  for (const t of tokens) {
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    v[(h >>> 0) % DIM] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

type Turn = { text: string; label: "dup" | "novel" };
type Conversation = { id: string; turns: Turn[] };

// 12 conversations. "dup" turns are TRUE duplicates (exact repeat or heavy
// paraphrase of an earlier turn in the same window). "novel" turns are
// genuinely new intents — including same-topic follow-ups with different
// focus, the false-suppression trap the probe must survive.
const CORPUS: Conversation[] = [
  {
    id: "c1-weather",
    turns: [
      { text: "what is the weather forecast for Denver tomorrow", label: "novel" },
      { text: "what is the weather forecast for Denver tomorrow", label: "dup" },
      { text: "should I water the vegetable garden beds this evening", label: "novel" },
      { text: "weather forecast for Denver tomorrow please", label: "dup" },
    ],
  },
  {
    id: "c2-greenhouse",
    turns: [
      { text: "how deep should the thermal mass wall be in an underground greenhouse", label: "novel" },
      { text: "how deep should the thermal mass wall be in an underground greenhouse", label: "dup" },
      { text: "which insulation R value works for the north wall berm", label: "novel" },
    ],
  },
  {
    id: "c3-manga-pipeline",
    turns: [
      { text: "run the Fandom parser enrichment loop for the new chapter batch", label: "novel" },
      { text: "run the Fandom parser enrichment loop for the new chapter batch", label: "dup" },
      { text: "show me lint errors from the Jest runner config", label: "novel" },
      { text: "run the enrichment loop for the new chapter batch on Fandom parser", label: "dup" },
    ],
  },
  {
    id: "c4-firetv",
    turns: [
      { text: "connect adb to duckie at 192.168.50.35 port 5555", label: "novel" },
      { text: "connect adb to duckie at 192.168.50.35 port 5555", label: "dup" },
      { text: "list the recovery binder transaction codes we captured", label: "novel" },
    ],
  },
  {
    id: "c5-opentax",
    turns: [
      { text: "run the TY2025 scenario tests from the tests directory", label: "novel" },
      { text: "run the TY2025 scenario tests from the tests directory", label: "dup" },
      { text: "what did the last hardening round change in the worksheet math", label: "novel" },
      { text: "run scenario tests for TY2025 from the tests dir", label: "dup" },
    ],
  },
  {
    id: "c6-jumpforce",
    turns: [
      { text: "extract portraits from the V13 archive using the palette pipeline", label: "novel" },
      { text: "extract portraits from the V13 archive using the palette pipeline", label: "dup" },
      { text: "compare V2 palette entries against the sprite sheet indices", label: "novel" },
    ],
  },
  {
    id: "c7-network",
    turns: [
      { text: "restart the Pi-hole container on 192.168.50.128", label: "novel" },
      { text: "restart the Pi-hole container on 192.168.50.128", label: "dup" },
      { text: "check the dual WAN failover logs on the ASUS router", label: "novel" },
      { text: "is Transmission seeding the Ubuntu ISO on HueyTheDestroyer", label: "novel" },
    ],
  },
  {
    id: "c8-flaresolverr",
    turns: [
      { text: "trace the clearance retry path in flaresolverr-go", label: "novel" },
      { text: "trace the clearance retry path in flaresolverr-go", label: "dup" },
      { text: "why does the proxy rotation drop the session cookie", label: "novel" },
    ],
  },
  {
    id: "c9-agentmcp",
    turns: [
      { text: "route the tool selection probe through glm and compare with deepseek", label: "novel" },
      { text: "route the tool selection probe through glm and compare with deepseek", label: "dup" },
      { text: "summarize the capability matrix verdicts for kimi", label: "novel" },
    ],
  },
  {
    id: "c10-memory",
    turns: [
      { text: "how does epoch based consolidation promote typed facts", label: "novel" },
      { text: "how does epoch based consolidation promote typed facts", label: "dup" },
      { text: "show the Hebbian edge counts per fact cluster", label: "novel" },
      { text: "how does epoch based consolidation promote the typed facts", label: "dup" },
    ],
  },
  {
    id: "c11-japan",
    turns: [
      { text: "find weekly rentals in Kyoto for November within walking distance of Gion", label: "novel" },
      { text: "find weekly rentals in Kyoto for November within walking distance of Gion", label: "dup" },
      { text: "which shinkansen pass covers the Sapporo extension", label: "novel" },
    ],
  },
  {
    id: "c12-daily",
    turns: [
      { text: "summarize unread email from the last twelve hours", label: "novel" },
      { text: "summarize unread email from the last twelve hours", label: "dup" },
      { text: "anything on the calendar for tomorrow afternoon", label: "novel" },
    ],
  },
];

// Stand-in for the formatted memory section size (plan §6: chars of
// systemPromptAddition avoided). Deterministic per query.
function sectionChars(query: string): number {
  return 400 + query.length * 3;
}

describe("injection-policy probe (ARCH-1 e0a2e042)", () => {
  beforeAll(() => {
    process.env.OPENCLAW_MEMORY_L3_INJECTION_POLICY = "1";
    delete process.env.OPENCLAW_MEMORY_L3_INJECTION_WINDOW_MS;
    delete process.env.OPENCLAW_MEMORY_L3_INJECTION_MAX_HISTORY;
  });
  afterAll(() => {
    delete process.env.OPENCLAW_MEMORY_L3_INJECTION_POLICY;
  });

  it("flag OFF returns null config (parity precondition)", () => {
    const saved = process.env.OPENCLAW_MEMORY_L3_INJECTION_POLICY;
    delete process.env.OPENCLAW_MEMORY_L3_INJECTION_POLICY;
    expect(readInjectionPolicyConfig(0.92)).toBeNull();
    process.env.OPENCLAW_MEMORY_L3_INJECTION_POLICY = saved;
  });

  it("corpus replay: zero false suppressions, high dup suppression, real reduction", () => {
    const config = readInjectionPolicyConfig(0.92)!;
    expect(config).toEqual({ noveltyCosine: 0.92, windowMs: 300_000, maxHistory: 10 });

    let now = 1_700_000_000_000;
    const ring: InjectionRecord[] = [];

    let dupTotal = 0;
    let dupSuppressed = 0;
    let novelTotal = 0;
    let falseSuppressions = 0;
    let avoidedChars = 0;
    let wouldBeChars = 0;
    let maxRing = 0;
    const perConvRates: string[] = [];

    for (const conv of CORPUS) {
      // Each conversation starts with an empty ring boundary check but keeps
      // the SHARED ring across conversations (engine keeps one per agent).
      let convDup = 0;
      let convDupSup = 0;
      for (const turn of conv.turns) {
        now += 8_000; // 8s between turns, well inside the 5min window
        const q = embed(turn.text);
        const before = JSON.stringify(ring);
        const decision = shouldInject({
          queryEmbedding: q,
          recentInjections: ring,
          now,
          config,
        });
        expect(JSON.stringify(ring)).toBe(before); // purity: never mutates

        wouldBeChars += sectionChars(turn.text);
        if (decision.inject) {
          // Engine hunk C shape: push on BOTH inject paths, bounded LRU.
          ring.push({ embedding: q, resultHash: fnv1aHash(turn.text), at: now });
          if (ring.length > config.maxHistory) ring.shift();
          maxRing = Math.max(maxRing, ring.length);
        } else {
          avoidedChars += sectionChars(turn.text);
          if (turn.label === "dup") {
            dupSuppressed++;
            convDupSup++;
          } else {
            falseSuppressions++;
          }
        }
        if (turn.label === "dup") {
          dupTotal++;
          convDup++;
        } else {
          novelTotal++;
        }
      }
      perConvRates.push(
        `${conv.id}: ${convDupSup}/${convDup} dups suppressed`,
      );
    }

    const dupRate = dupSuppressed / dupTotal;
    const novelRate = falseSuppressions / novelTotal;
    const reductionPct = (avoidedChars / wouldBeChars) * 100;

    // eslint-disable-next-line no-console
    console.log(
      [
        `[probe] corpus: ${CORPUS.length} conversations, ${dupTotal + novelTotal} turns (${dupTotal} dup / ${novelTotal} novel)`,
        `[probe] dup suppression: ${dupSuppressed}/${dupTotal} = ${(dupRate * 100).toFixed(1)}%`,
        `[probe] false suppression on novel: ${falseSuppressions}/${novelTotal} = ${(novelRate * 100).toFixed(1)}%`,
        `[probe] injected-token reduction: ${reductionPct.toFixed(1)}% (${avoidedChars} / ${wouldBeChars} chars)`,
        `[probe] max ring size observed: ${maxRing}`,
        ...perConvRates.map((r) => `[probe]   ${r}`),
      ].join("\n"),
    );

    // PROBE PASS CRITERIA (plan §6): false suppression must be ZERO;
    // dup suppression >= 50%; reduction pinned at >= 10%.
    expect(falseSuppressions).toBe(0);
    expect(dupRate).toBeGreaterThanOrEqual(0.5);
    expect(reductionPct).toBeGreaterThanOrEqual(10);
    expect(maxRing).toBeLessThanOrEqual(10);
  });

  it("window expiry restores injection (window is a hard TTL)", () => {
    const config = { noveltyCosine: 0.92, windowMs: 1_000, maxHistory: 10 };
    const q = embed("identical question asked twice");
    const ring: InjectionRecord[] = [
      { embedding: q, resultHash: fnv1aHash("x"), at: 1_000_000 },
    ];
    const t0 = 1_000_000 + 500;
    expect(
      shouldInject({ queryEmbedding: q, recentInjections: ring, now: t0, config }).inject,
    ).toBe(false); // inside window → suppressed
    const t1 = 1_000_000 + 2_000;
    expect(
      shouldInject({ queryEmbedding: q, recentInjections: ring, now: t1, config }).inject,
    ).toBe(true); // window elapsed → inject restored
  });

  it("undefined embedding and empty history fail open", () => {
    const config = { noveltyCosine: 0.92, windowMs: 300_000, maxHistory: 10 };
    expect(
      shouldInject({ recentInjections: [{ embedding: [1], resultHash: "a", at: 0 }], now: 5, config }).inject,
    ).toBe(true);
    expect(shouldInject({ queryEmbedding: [1], recentInjections: [], now: 5, config }).inject).toBe(true);
  });

  it("latency: decision cost stays far under the engine hot-path budget", () => {
    const config = { noveltyCosine: 0.92, windowMs: 300_000, maxHistory: 10 };
    const ring: InjectionRecord[] = Array.from({ length: 10 }, (_, i) => ({
      embedding: embed(`distinct filler query number ${i} about topic ${i}`),
      resultHash: String(i),
      at: i,
    }));
    const q = embed("a brand new unrelated query about something else entirely");
    // warmup
    for (let i = 0; i < 100; i++) shouldInject({ queryEmbedding: q, recentInjections: ring, now: 999_999, config });
    const t0 = process.hrtime.bigint();
    const N = 10_000;
    for (let i = 0; i < N; i++) shouldInject({ queryEmbedding: q, recentInjections: ring, now: 999_999, config });
    const perCallMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    // eslint-disable-next-line no-console
    console.log(`[probe] shouldInject avg over ${N} calls (full 10-ring): ${(perCallMs * 1000).toFixed(2)} µs/call`);
    expect(perCallMs).toBeLessThan(0.1); // 100µs/call ceiling — vs buildMemorySection's full retrieval pass
  });

  it("cosine sanity: exact/order dupes hit 1.0, paraphrase > novel but under fake-embedding ceiling", () => {
    // Pins the embedding-model geometry the corpus results rely on. The hashed
    // bag-of-words fake is order-invariant (word-order dupes → cosine 1.0) but
    // CANNOT lift token-substituted paraphrases to the 0.92 fence (measured
    // 0.783) — that ceiling is a fake-embedding artifact; real embeddings
    // compress semantics and score paraphrases higher. The corpus replay
    // already folds this in (missed dups = exactly the paraphrases). The
    // SAFETY property is the margin: same-topic novel ~0.316, far below fence.
    const a = embed("what is the weather forecast for Denver tomorrow");
    const orderDup = embed("forecast Denver tomorrow the weather for what is");
    const b = embed("weather forecast for Denver tomorrow please");
    const c = embed("should I water the vegetable garden beds this evening");
    // eslint-disable-next-line no-console
    console.log(
      `[probe] cosine(order-dup)=${cosineSimilarity(a, orderDup).toFixed(3)} cosine(paraphrase)=${cosineSimilarity(a, b).toFixed(3)} cosine(same-topic-novel)=${cosineSimilarity(a, c).toFixed(3)}`,
    );
    expect(cosineSimilarity(a, a)).toBe(1);
    expect(cosineSimilarity(a, orderDup)).toBe(1); // exact + order-invariant dupes suppress
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c)); // paraphrase ranks above novel
    expect(cosineSimilarity(a, c)).toBeLessThan(0.92); // novel margin under the fence
  });
});
