/**
 * Server modules that the Control UI bundle swaps for browser-safe equivalents.
 *
 * Shared by the Vite build (which performs the swap) and
 * `scripts/check-control-ui-server-imports.ts` (which must model it to avoid
 * reporting an aliased edge as a violation). Keep this the single source: if the
 * two drift, the checker either misses a real leak or blocks a safe build.
 */

export type ControlUiBrowserAlias = {
  /** Repo-relative importer whose specifier is rewritten. */
  importer: string;
  /** Specifier exactly as written in the importer. */
  source: string;
  /** Repo-relative browser-safe replacement. */
  replacement: string;
};

export const CONTROL_UI_BROWSER_ALIASES: readonly ControlUiBrowserAlias[] = [
  {
    importer: "src/agents/tool-display-common.ts",
    source: "../logging/redact.js",
    replacement: "ui/src/ui/browser-redact.ts",
  },
  {
    importer: "src/agents/tool-display-exec.ts",
    source: "../logging/redact.js",
    replacement: "ui/src/ui/browser-redact.ts",
  },
  {
    importer: "src/agents/tool-display.ts",
    source: "../logging/redact.js",
    replacement: "ui/src/ui/browser-redact.ts",
  },
];
