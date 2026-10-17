#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// zai-cache-probe.mjs — R2 wire-level verification of zai prompt caching
//
// Source: self-improvement-lab card 9e633f3e (ARCH-3), plan stage
// 2026-10-15 §C. Mirrors the provider wire pinned from
// src/agents/tools/delegation/providers/zai.ts:
//   - POST <base>/chat/completions
//   - system message tagged cache_control {type:"ephemeral"} unless disabled
//     (zai.ts L99; implicit caching already seen by probe-2026-05)
//   - cache hits surface at usage.prompt_tokens_details.cached_tokens
//     (OpenAI-standard nested field — NOT DeepSeek prompt_cache_hit_tokens)
//
// Two identical calls with >2KB fixed system prompt; the second should show
// cached_tokens > 0. SPEND-GATED: refuses to run without an explicit --spend
// flag AND a resolvable key (ZAI_API_KEY env or --api-key). Costs ~cents.
//
// Usage:
//   node extensions/memory-l3/scripts/zai-cache-probe.mjs --spend \
//     [--base-url=https://api.z.ai/api/paas/v4] [--model=glm-4.7] \
//     [--api-key=...] [--timeout-ms=60000]
// ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4";
export const DEFAULT_MODEL = "glm-4.7";

/** Builds the outbound body mirroring zai.ts buildMessages + defaults. */
export function buildRequestBody({ systemPrompt, userPrompt, useCache = true, model = DEFAULT_MODEL, maxTokens = 64 }) {
  const sysMsg = { role: "system", content: systemPrompt };
  if (useCache) sysMsg.cache_control = { type: "ephemeral" };
  return {
    model,
    messages: [sysMsg, { role: "user", content: userPrompt }],
    max_tokens: maxTokens,
    temperature: 0.3,
    stream: false,
  };
}

/** Wire evidence: serialized body contains a cache_control tag on the system message. */
export function wireHasCacheControl(body) {
  const sys = body?.messages?.[0];
  return Boolean(sys && sys.role === "system" && sys.cache_control?.type === "ephemeral");
}

/**
 * Verdict per design §D.
 *   wire  — outbound body carries cache_control
 *   usage — call-2 reports prompt_tokens_details.cached_tokens > 0
 *   cost  — (optional) call-2 input cost < call-1, only decidable when both
 *           full and cached per-M rates are provided
 * overall: all present → "verified"; wire-only → "emitted, server-unverified";
 *          usage false with wire true → "emitted, cache-miss (retry later)";
 *          wire false → "failed".
 */
export function classifyVerdict({ call1Usage, call2Usage, wireEvidence, pricing }) {
  const wire = wireEvidence === true;
  const cached2 = Number(
    call2Usage?.prompt_tokens_details?.cached_tokens ?? 0,
  );
  const usage = cached2 > 0;
  let cost = null;
  if (pricing && pricing.inputPerM !== undefined && pricing.cachedPerM !== undefined) {
    const costOf = (u) => {
      const prompt = Number(u?.prompt_tokens ?? 0);
      const cached = Number(u?.prompt_tokens_details?.cached_tokens ?? 0);
      return ((prompt - cached) * pricing.inputPerM + cached * pricing.cachedPerM) / 1e6;
    };
    const c1 = costOf(call1Usage);
    const c2 = costOf(call2Usage);
    cost = c1 > 0 ? c2 < c1 : null;
  }
  let overall;
  if (!wire) overall = "failed";
  else if (usage && cost === true) overall = "verified";
  else if (usage && cost === null) overall = "verified (usage; cost n/a)";
  else if (usage && cost === false) overall = "verified-usage, cost-regressed";
  else if (!call2Usage) overall = "emitted, server-unverified";
  else overall = "emitted, cache-miss (retry later)";
  return { wire, usage, cost, overall, cachedTokens2: cached2 };
}

async function callOnce({ baseUrl, apiKey, body, timeoutMs, fetchImpl = fetch }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function runProbe({ baseUrl, apiKey, model, timeoutMs, fetchImpl }) {
  const filler =
    "You are a telemetry probe agent. This block exists to exceed the 2KB " +
    "prefix threshold providers use before admitting a prompt into cache. ".repeat(24);
  const systemPrompt = `# Probe system preamble\n${filler}`;
  const userPrompt = "Reply with exactly: ok";
  const body = buildRequestBody({ systemPrompt, userPrompt, useCache: true, model });
  const wire = wireHasCacheControl(body);
  const call1 = await callOnce({ baseUrl, apiKey, body, timeoutMs, fetchImpl });
  // brief settle so the provider registers the cached prefix
  await new Promise((r) => setTimeout(r, 1500));
  let call2;
  let lastErr;
  for (let attempt = 0; attempt < 2 && !call2; attempt++) {
    try {
      call2 = await callOnce({ baseUrl, apiKey, body, timeoutMs, fetchImpl });
    } catch (err) {
      lastErr = err;
    }
  }
  if (!call2) throw lastErr ?? new Error("call 2 failed");
  return {
    wire,
    call1Usage: call1?.usage ?? null,
    call2Usage: call2?.usage ?? null,
  };
}

export async function main(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  const apiKey = String(args["api-key"] ?? process.env.ZAI_API_KEY ?? "");
  if (args.spend !== true) {
    console.error("refusing: pass --spend to acknowledge the ~cents cost");
    process.exitCode = 2;
    return;
  }
  if (!apiKey) {
    console.error("refusing: no --api-key and no ZAI_API_KEY in env");
    process.exitCode = 2;
    return;
  }
  const result = await runProbe({
    baseUrl: String(args["base-url"] ?? DEFAULT_BASE_URL),
    apiKey,
    model: String(args.model ?? DEFAULT_MODEL),
    timeoutMs: Number(args["timeout-ms"] ?? 60000),
  });
  const verdict = classifyVerdict(result);
  console.log(JSON.stringify({ ...result, verdict }, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith("zai-cache-probe.mjs")) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
