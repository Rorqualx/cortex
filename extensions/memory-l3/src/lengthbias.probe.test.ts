/**
 * PROBE (throwaway) — ARCH-2 length-bias measurement over the live L3 store.
 * Evidence gate: |ρ| ≥ 0.15 (Spearman, cosine vs token count) decides whether
 * length-normalization ships with non-identity defaults.
 * Reads a COPY of the store at $L3_PROBE_DB (never the live file).
 * Card e25a98de · cycle 2026-09-10.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { tokenize } from "./scoring.js";

const DB_PATH = process.env.L3_PROBE_DB ?? "";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function rank(arr: number[]): number[] {
  const idx = arr.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  const out = new Array<number>(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2; // average rank for ties
    for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

function spearman(x: number[], y: number[]): number {
  const rx = rank(x);
  const ry = rank(y);
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += rx[i];
    my += ry[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

describe.skipIf(!DB_PATH)("length-bias probe (live store copy)", () => {
  it("measures Spearman ρ(cosine, tokenCount) across pseudo-queries", () => {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const chunks = db
      .prepare("SELECT id, text, embedding FROM l3_message_chunks")
      .all() as Array<{ id: string; text: string; embedding: string }>;
    const hype = db
      .prepare("SELECT fact_id, query_seq, embedding FROM l3_hype_queries")
      .all() as Array<{ fact_id: string; query_seq: number; embedding: string }>;
    db.close();

    expect(chunks.length).toBeGreaterThan(100);
    const texts = chunks.map((c) => c.text);
    const embs = chunks.map((c) => JSON.parse(c.embedding) as number[]);
    const tokenCounts = texts.map((t) => tokenize(t).size);

    // Pseudo-queries: HyPE hypothetical-query embeddings (query-shaped vectors);
    // fallback to sampled chunk embeddings when HyPE is unpopulated.
    let queries = hype
      .slice(0, 400)
      .map((h) => JSON.parse(h.embedding) as number[])
      .filter((e) => e.length > 0);
    if (queries.length === 0) {
      const stride = Math.max(1, Math.floor(embs.length / 200));
      queries = embs.filter((_, i) => i % stride === 0);
    }
    expect(queries.length).toBeGreaterThan(20);

    const rhos: number[] = [];
    const topKRhos: number[] = [];
    const topK = 50;
    for (const q of queries) {
      const sims = embs.map((e) => cosine(q, e));
      rhos.push(spearman(sims, tokenCounts));
      // Retrieval-relevant regime: top-K by cosine, then correlate rank position
      // with token count (does length stratify the shortlist?).
      const order = sims.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
      const topIdx = order.slice(0, topK).map(([, i]) => i);
      if (topIdx.length === topK) {
        topKRhos.push(
          spearman(
            topIdx.map((i) => sims[i]),
            topIdx.map((i) => tokenCounts[i]),
          ),
        );
      }
    }

    // ── λ/τ fit: grid-search to null the global rank correlation ──
    // s' = s / (1 + λ·max(0, ln(tokens/τ))). Exclude the self-pair (q itself).
    const fit: Array<{ lambda: number; tau: number; rhoMedian: number }> = [];
    const precomputed = queries.map((q) => {
      const qi = embs.indexOf(q);
      const sims: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i < embs.length; i++) {
        if (i === qi) continue;
        sims.push(cosine(q, embs[i]));
        idx.push(i);
      }
      return { sims, idx };
    });
    for (const tau of [206, 266]) {
      const ln = tokenCounts.map((tc) => Math.max(0, Math.log(tc / tau)));
      for (let lam = 0.02; lam <= 0.3001; lam += 0.01) {
        const adj: number[] = [];
        for (const { sims, idx } of precomputed) {
          adj.push(
            spearman(
              sims.map((s, j) => s / (1 + lam * ln[idx[j]])),
              idx.map((i) => ln[i]),
            ),
          );
        }
        fit.push({ lambda: Number(lam.toFixed(2)), tau, rhoMedian: Number(median(adj).toFixed(4)) });
      }
    }
    fit.sort((a, b) => Math.abs(a.rhoMedian) - Math.abs(b.rhoMedian));
    console.log("PROBE-FIT-BEST " + JSON.stringify(fit.slice(0, 5)));

    // Token-count stats for τ fitting.
    const sortedTc = [...tokenCounts].sort((a, b) => a - b);
    const stats = {
      chunks: chunks.length,
      hypeQueries: queries.length,
      tokenMedian: median(tokenCounts),
      tokenP25: sortedTc[Math.floor(sortedTc.length * 0.25)],
      tokenP75: sortedTc[Math.floor(sortedTc.length * 0.75)],
      rhoMedian: Number(median(rhos).toFixed(4)),
      rhoMean: Number((rhos.reduce((a, b) => a + b, 0) / rhos.length).toFixed(4)),
      rhoAbsMedian: Number(median(rhos.map(Math.abs)).toFixed(4)),
      topKRhoMedian: Number(median(topKRhos).toFixed(4)),
      shareAbsGte015: Number((rhos.filter((r) => Math.abs(r) >= 0.15).length / rhos.length).toFixed(3)),
    };
    console.log("PROBE-STATS " + JSON.stringify(stats));
    expect(Number.isFinite(stats.rhoMedian)).toBe(true);
  });
});
