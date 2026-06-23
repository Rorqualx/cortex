// Auto-recover from a stale code-split chunk after a redeploy.
//
// When the Control UI is rebuilt, lazy chunks get new hashed filenames and the
// old ones are deleted. A browser still running the previous in-memory SPA then
// 404s when it lazy-imports a now-deleted chunk ("Failed to fetch dynamically
// imported module"). Rather than stranding the user on a manual reload panel, we
// reload once to pick up the current bundle.
//
// A sessionStorage timestamp guards across the reload itself and a per-load flag
// guards within a single page load, so a chunk that is genuinely broken (not
// merely stale) can never loop the page forever — it falls through to the manual
// recovery panel instead.

const RELOAD_GUARD_KEY = "openclaw:stale-chunk-reload-at";
const RELOAD_MIN_INTERVAL_MS = 10_000;

const STALE_CHUNK_MESSAGE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|module script failed|unable to preload/i;

/** True when an error looks like a missing/stale dynamically-imported chunk. */
export function isStaleChunkError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String((error as { message?: unknown })?.message ?? error ?? "");
  return STALE_CHUNK_MESSAGE.test(message);
}

let reloadedThisLoad = false;

/**
 * Reload once to recover from a stale chunk, guarded against reload loops.
 * Returns true when a reload was triggered.
 */
export function reloadForStaleChunk(): boolean {
  if (reloadedThisLoad) {
    return false;
  }
  try {
    const now = Date.now();
    const last = Number(globalThis.sessionStorage?.getItem(RELOAD_GUARD_KEY) ?? "0");
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_MIN_INTERVAL_MS) {
      // We already reloaded for a stale chunk very recently and it did not help,
      // so this chunk is broken, not stale — stop and let the manual panel show.
      return false;
    }
    globalThis.sessionStorage?.setItem(RELOAD_GUARD_KEY, String(now));
  } catch {
    // sessionStorage unavailable (private mode): the per-load flag still prevents
    // multiple reloads within this page load.
  }
  reloadedThisLoad = true;
  globalThis.location.reload();
  return true;
}
