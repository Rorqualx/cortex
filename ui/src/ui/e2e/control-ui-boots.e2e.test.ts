// Control UI boot smoke: the app bundle must register openclaw-app.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

/**
 * Every other Control UI e2e asserts on rendered content, which presumes the app
 * already booted. Nothing asserted the boot itself, so a module that throws
 * during evaluation took the whole dashboard down while the suite stayed green:
 * the static shell still serves, but the entry chain dies before
 * customElements.define("openclaw-app") and the page shows the "Control UI did
 * not start" fallback, which misattributes it to a browser extension.
 *
 * scripts/check-control-ui-server-imports.ts catches the known cause (a server
 * module doing host work at import time). This catches the symptom whatever the
 * cause — a bad polyfill, a top-level await, a plugin ordering change.
 */
describeControlUiE2e("Control UI boot smoke", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("registers the openclaw-app element with no module-evaluation error", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    // Module-evaluation throws surface here, not as a failed request: the chunk
    // downloads fine and then dies while running.
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installMockGateway(page);

    try {
      const response = await page.goto(server.baseUrl);
      expect(response?.status()).toBe(200);

      // Generous timeout: the dev server transforms the entry graph on first
      // request, so a cold run is far slower than the poll default.
      await expect
        .poll(() => page.evaluate(() => Boolean(customElements.get("openclaw-app"))), {
          timeout: 30_000,
          interval: 250,
        })
        .toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
