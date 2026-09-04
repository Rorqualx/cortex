// Vitest ui config wires the ui test shard.
import type { ViteUserConfig } from "vitest/config";
// Fork-UI-ownership: does NOT import ui/config/control-ui-locales.ts. That file
// is upstream-only UI the fork-UI-ownership policy drops; importing it broke
// every vitest run on this branch until 85c151fc4c5a restored this file.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";
import { uiIsolatedTestFiles } from "./vitest.ui-isolated-paths.mjs";
import { uiNodeDrivenBrowserTestFiles } from "./vitest.ui-paths.mjs";

// Explicit nameable return type: inference reaches vite-internal names (TS4058/TS4082).
export function createUiVitestConfig(env?: Record<string, string | undefined>): ViteUserConfig {
  const includePatterns = ["ui/src/**/!(*.browser).test.ts", ...uiNodeDrivenBrowserTestFiles];
  // Isolated files must never enter the shared module graph, including scoped runs.
  const exclude = ["ui/src/**/*.e2e.test.ts", ...uiIsolatedTestFiles];
  return createScopedVitestConfig(includePatterns, {
    deps: jsdomOptimizedDeps,
    environment: "jsdom",
    env,
    exclude,
    excludeUnitFastTests: false,
    includeOpenClawRuntimeSetup: false,
    intersectIncludeFile: true,
    isolate: false,
    name: "ui",
    setupFiles: ["ui/src/test-helpers/lit-warnings.setup.ts"],
    useNonIsolatedRunner: true,
  });
}

export default createUiVitestConfig();
