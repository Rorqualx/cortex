/**
 * Single source of truth for an agent's avatar across the whole Control UI.
 *
 * Resolution order:
 *   1. An explicitly assigned avatar (identity.avatarUrl / identity.avatar) when
 *      it is safe to render directly (a data: image or a same-origin path).
 *   2. Otherwise the procedural pixel-invader, deterministically generated from
 *      the agent id, so every agent has a stable, distinct avatar everywhere —
 *      chat, the workboard, the improvement lab, presence badges, and the office.
 *
 * Returns a string usable directly as an <img src>.
 */
import { generateInvader, invaderColor, invaderDataUri } from "./invader.ts";

// The global OpenClaw logo assets are placeholders, not a real per-agent avatar,
// so an agent carrying one should still get its distinct generated invader.
const DEFAULT_AVATAR_ASSET = /apple-touch-icon|favicon/i;

/** True for the shared OpenClaw logo placeholders (favicon / apple-touch-icon). */
export function isDefaultAvatarAsset(value: string | null | undefined): boolean {
  return Boolean(value && DEFAULT_AVATAR_ASSET.test(value));
}

/**
 * True only for a genuinely assigned avatar image (uploaded photo or same-origin
 * route). Excludes the logo placeholders AND our own generated invader SVGs — a
 * stored generated invader is re-derived from the id instead, so every surface
 * shows the same canonical invader regardless of stale picker artifacts.
 */
export function isHonoredAvatarUrl(value: string | null | undefined): boolean {
  if (!value || isDefaultAvatarAsset(value)) {
    return false;
  }
  if (/^data:image\/svg\+xml/i.test(value)) {
    return false;
  }
  return /^(data:image\/|\/(?!\/))/i.test(value);
}

export type AgentAvatarSource = {
  avatar?: string | null;
  avatarUrl?: string | null;
};

/** Resolve the avatar URL for an agent: assigned avatar, else generated invader. */
export function agentAvatarUrl(
  agentId: string,
  source?: AgentAvatarSource | null,
  opts: { animate?: boolean } = {},
): string {
  const assigned = source?.avatarUrl ?? source?.avatar ?? null;
  if (assigned && isHonoredAvatarUrl(assigned)) {
    return assigned;
  }
  return invaderDataUri(generateInvader(agentId), invaderColor(agentId), {
    animate: opts.animate ?? true,
  });
}
