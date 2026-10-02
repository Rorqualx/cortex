/**
 * PROBE (throwaway) — Novelty-gated injection policy, v1 minimal surface.
 * Card: ARCH-1 e0a2e042 — probe-stage feasibility spike (cron worktree only).
 * Implements the exact surface pinned by the 2026-09-30 plan doc §2:
 *   readInjectionPolicyConfig(noveltyCosine) — per-call env read, null when flag OFF
 *   shouldInject(input) — pure decision, never mutates the ring
 *   fnv1aHash(s) — FNV-1a hex hash
 * Cosine reuses the REAL scoring.ts function (engine.ts:44 precedent).
 */

export type InjectionRecord = { embedding: number[]; resultHash: string; at: number };

export type InjectionPolicyConfig = {
  noveltyCosine: number;
  windowMs: number;
  maxHistory: number;
};

/** Null when the flag is OFF (per-call env read; one string compare when off). */
export function readInjectionPolicyConfig(noveltyCosine: number): InjectionPolicyConfig | null {
  if (process.env.OPENCLAW_MEMORY_L3_INJECTION_POLICY !== "1") return null;
  const windowRaw = Number(process.env.OPENCLAW_MEMORY_L3_INJECTION_WINDOW_MS);
  const historyRaw = Number(process.env.OPENCLAW_MEMORY_L3_INJECTION_MAX_HISTORY);
  const windowMs =
    Number.isFinite(windowRaw) && windowRaw > 0 ? windowRaw : 300_000;
  const maxHistory = Number.isFinite(historyRaw)
    ? Math.min(10, Math.max(1, Math.trunc(historyRaw)))
    : 10;
  return { noveltyCosine, windowMs, maxHistory };
}

/**
 * Pure decision: skip iff ∃ record with cosine(q, rec.embedding) ≥ noveltyCosine
 * AND now − rec.at ≤ windowMs. undefined embedding / empty history → inject.
 * Iterates newest-last (mirrors the ReTopK loop shape, engine.ts:308-321).
 */
export function shouldInject(input: {
  queryEmbedding?: number[];
  recentInjections: InjectionRecord[];
  now: number;
  config: InjectionPolicyConfig;
}): { inject: boolean; matchedIndex?: number } {
  const { queryEmbedding, recentInjections, now, config } = input;
  if (!queryEmbedding || recentInjections.length === 0) return { inject: true };
  for (let i = recentInjections.length - 1; i >= 0; i--) {
    const rec = recentInjections[i]!;
    if (now - rec.at > config.windowMs) continue;
    if (cosineSimilarity(queryEmbedding, rec.embedding) >= config.noveltyCosine) {
      return { inject: false, matchedIndex: i };
    }
  }
  return { inject: true };
}

import { cosineSimilarity } from "./scoring.js";

/** Cheap FNV-1a 32-bit hex hash (debug/dedup only). */
export function fnv1aHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
