// Control UI controller for the Skill Forge pipeline.

import type { GatewayBrowserClient } from "../gateway.ts";

// ── Types ──────────────────────────────────────────────────────────

export type ForgeCandidate = {
  id: string;
  lane: string;
  failingTool: string;
  recoveringTool: string;
  rationale: string;
};

export type ForgeSkillStatus = "promoted" | "staged" | "retired" | "candidate";

export type ForgeSkill = {
  name: string;
  description: string;
  status: ForgeSkillStatus;
  usageCount: number;
  lastUsedAt: string | null;
  promotedAt: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
  createdAt: string | null;
};

export type ForgeStatus = {
  candidates: number;
  promoted: number;
  staged: number;
  retired: number;
  telemetry: number;
  skills: {
    candidates: ForgeCandidate[];
    promoted: ForgeSkill[];
    staged: ForgeSkill[];
    retired: ForgeSkill[];
  };
};

export type ForgeRunResult = {
  scannedCaptureDirs: number;
  candidateCount: number;
  draftedCount: number;
  promotedCount: number;
  drafted: Array<{ name: string; skillDir: string }>;
  promotions: unknown[];
};

export type ForgeActionNotice = {
  type: "success" | "error";
  message: string;
};

export type SkillForgeState = {
  skillForgeLoading: boolean;
  skillForgeLoaded: boolean;
  skillForgeError: string | null;
  skillForgeStatus: ForgeStatus | null;
  skillForgeSelectedName: string | null;
  skillForgeRunBusy: boolean;
  skillForgeActionBusy: string | null;
  skillForgeActionNotice: ForgeActionNotice | null;
  skillForgeActionNoticeTimer?: ReturnType<typeof globalThis.setTimeout> | number | null;
  skillForgeFilter: ForgeSkillStatus | "all";
  skillForgeQuery: string;
  skillForgeMode: "board" | "grid";
  skillForgeQueueWidth: number;
};

// ── Helpers ────────────────────────────────────────────────────────

function clearActionNoticeTimer(state: SkillForgeState): void {
  if (state.skillForgeActionNoticeTimer) {
    globalThis.clearTimeout(state.skillForgeActionNoticeTimer);
    state.skillForgeActionNoticeTimer = null;
  }
}

function setActionNotice(state: SkillForgeState, type: "success" | "error", message: string): void {
  // Clear any in-flight dismissal timer so rapid successive notices don't leak
  // orphan timeouts that fire against a newer notice.
  clearActionNoticeTimer(state);
  state.skillForgeActionNotice = { type, message };
  state.skillForgeActionNoticeTimer = globalThis.setTimeout(() => {
    if (state.skillForgeActionNotice) {
      state.skillForgeActionNotice = null;
    }
    state.skillForgeActionNoticeTimer = null;
  }, 4000);
}

// ── Data loading ───────────────────────────────────────────────────

export async function loadSkillForgeStatus(
  state: SkillForgeState & { client?: GatewayBrowserClient | null; connected?: boolean },
  options?: { force?: boolean },
): Promise<void> {
  if (!state.client || !state.connected || state.skillForgeLoading) {
    return;
  }
  if (state.skillForgeLoaded && !options?.force) {
    return;
  }

  state.skillForgeLoading = true;
  state.skillForgeError = null;
  try {
    const result = await state.client.request("skills.forge.status", {});
    state.skillForgeStatus = result as ForgeStatus;
    state.skillForgeLoaded = true;

    // Auto-select first skill if nothing selected
    if (!state.skillForgeSelectedName) {
      const all = allSkills(state);
      state.skillForgeSelectedName = all[0]?.name ?? null;
    }
  } catch (err) {
    state.skillForgeError = getErrorMessage(err);
  } finally {
    state.skillForgeLoading = false;
  }
}

// ── Actions ────────────────────────────────────────────────────────

export async function runForgePipeline(
  state: SkillForgeState & { client?: GatewayBrowserClient | null; connected?: boolean },
): Promise<void> {
  if (!state.client || !state.connected || state.skillForgeRunBusy) {
    return;
  }

  state.skillForgeRunBusy = true;
  state.skillForgeError = null;
  try {
    const result = (await state.client.request("skills.forge.run", {})) as ForgeRunResult;
    setActionNotice(
      state,
      "success",
      `Pipeline complete: ${result.draftedCount} drafted, ${result.promotedCount} promoted`,
    );
    // Refresh status
    state.skillForgeLoaded = false;
    await loadSkillForgeStatus(state, { force: true });
  } catch (err) {
    state.skillForgeError = getErrorMessage(err);
    setActionNotice(state, "error", getErrorMessage(err));
  } finally {
    state.skillForgeRunBusy = false;
  }
}

export async function promoteSkill(
  state: SkillForgeState & { client?: GatewayBrowserClient | null; connected?: boolean },
  name: string,
): Promise<void> {
  if (!state.client || !state.connected || state.skillForgeActionBusy) {
    return;
  }

  state.skillForgeActionBusy = name;
  state.skillForgeError = null;
  try {
    await state.client.request("skills.forge.promote", { name });
    setActionNotice(state, "success", `Promoted "${name}"`);
    state.skillForgeLoaded = false;
    await loadSkillForgeStatus(state, { force: true });
  } catch (err) {
    state.skillForgeError = getErrorMessage(err);
    setActionNotice(state, "error", `Promotion failed: ${getErrorMessage(err)}`);
  } finally {
    if (state.skillForgeActionBusy === name) {
      state.skillForgeActionBusy = null;
    }
  }
}

export async function retireSkill(
  state: SkillForgeState & { client?: GatewayBrowserClient | null; connected?: boolean },
  name: string,
  reason?: string,
): Promise<void> {
  if (!state.client || !state.connected || state.skillForgeActionBusy) {
    return;
  }

  state.skillForgeActionBusy = name;
  state.skillForgeError = null;
  try {
    await state.client.request("skills.forge.retire", {
      name,
      reason: reason ?? "manual retirement",
    });
    setActionNotice(state, "success", `Retired "${name}"`);
    state.skillForgeLoaded = false;
    await loadSkillForgeStatus(state, { force: true });
  } catch (err) {
    state.skillForgeError = getErrorMessage(err);
    setActionNotice(state, "error", `Retire failed: ${getErrorMessage(err)}`);
  } finally {
    if (state.skillForgeActionBusy === name) {
      state.skillForgeActionBusy = null;
    }
  }
}

export async function runDecaySweep(
  state: SkillForgeState & { client?: GatewayBrowserClient | null; connected?: boolean },
): Promise<void> {
  if (!state.client || !state.connected || state.skillForgeRunBusy) {
    return;
  }

  state.skillForgeRunBusy = true;
  state.skillForgeError = null;
  try {
    const result = (await state.client.request("skills.forge.retire", {})) as {
      retiredCount: number;
    };
    setActionNotice(state, "success", `Decay sweep: ${result.retiredCount} skills retired`);
    state.skillForgeLoaded = false;
    await loadSkillForgeStatus(state, { force: true });
  } catch (err) {
    state.skillForgeError = getErrorMessage(err);
    setActionNotice(state, "error", getErrorMessage(err));
  } finally {
    state.skillForgeRunBusy = false;
  }
}

// ── Selection / filtering ──────────────────────────────────────────

export function allSkills(state: SkillForgeState): ForgeSkill[] {
  if (!state.skillForgeStatus) {
    return [];
  }
  const { promoted, staged, retired } = state.skillForgeStatus.skills;
  return [...promoted, ...staged, ...retired];
}

export function allCandidates(state: SkillForgeState): ForgeCandidate[] {
  return state.skillForgeStatus?.skills.candidates ?? [];
}

export function filteredSkills(state: SkillForgeState): ForgeSkill[] {
  const all = allSkills(state);
  let filtered = all;

  if (state.skillForgeFilter !== "all") {
    filtered = filtered.filter((s) => s.status === state.skillForgeFilter);
  }

  if (state.skillForgeQuery.trim()) {
    const q = state.skillForgeQuery.toLowerCase();
    filtered = filtered.filter((s) => s.name.toLowerCase().includes(q));
  }

  return filtered;
}

export function selectSkillForge(state: SkillForgeState, name: string): void {
  state.skillForgeSelectedName = name;
}

export function countSkillForge(state: SkillForgeState): Record<ForgeSkillStatus | "all", number> {
  const all = allSkills(state);
  const candidates = allCandidates(state);
  return {
    all: all.length + candidates.length,
    candidate: candidates.length,
    promoted: all.filter((s) => s.status === "promoted").length,
    staged: all.filter((s) => s.status === "staged").length,
    retired: all.filter((s) => s.status === "retired").length,
  };
}

// ── Mode persistence ───────────────────────────────────────────────

const FORGE_MODE_KEY = "openclaw:skill-forge-mode:v1";

export function loadSkillForgeMode(): "board" | "grid" {
  try {
    const stored = localStorage.getItem(FORGE_MODE_KEY);
    if (stored === "grid") {
      return "grid";
    }
  } catch {}
  return "board";
}

export function setSkillForgeMode(state: SkillForgeState, mode: "board" | "grid"): void {
  state.skillForgeMode = mode;
  try {
    localStorage.setItem(FORGE_MODE_KEY, mode);
  } catch {}
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
