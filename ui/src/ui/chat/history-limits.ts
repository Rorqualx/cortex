// Control UI chat module implements history limits behavior.
// Whole-history contract: the chat thread renders the full transcript with no
// count/char gating. The historyRenderLimit prop mechanism stays for explicit
// callers (and tests), so the defaults are simply unbounded.
export const CHAT_HISTORY_RENDER_LIMIT = Number.POSITIVE_INFINITY;
export const CHAT_HISTORY_RENDER_CHAR_BUDGET = Number.POSITIVE_INFINITY;
export const CHAT_HISTORY_RENDER_EXPAND_STEP = 100;
