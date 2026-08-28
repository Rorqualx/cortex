import { describe, expect, it } from "vitest";
import {
  buildExternalPluginLocalDist,
  listExternalPluginLocalDistPackageDirs,
} from "../../scripts/build-external-plugin-local-dist.mts";
import {
  collectRootPackageExcludedExtensionDirs,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";

describe("external plugin local dist build", () => {
  it("selects every externalized first-party plugin behind a package exclusion", () => {
    const packageDirs = listExternalPluginLocalDistPackageDirs();
    const excludedPluginIds = collectRootPackageExcludedExtensionDirs();

    // A floor, not an exact count: the fork ships a different externalized-plugin
    // set than upstream (58 vs upstream's 63 at the 2026-08-26 resync), and every
    // upstream resync that adds or drops a plugin would otherwise re-break this on
    // a magic number. The real contract is proven below — every selected dir sits
    // behind a package exclusion — plus the explicit membership checks; the floor
    // only guards against the selection collapsing to empty/truncated.
    expect(packageDirs.length).toBeGreaterThanOrEqual(50);
    expect(packageDirs).toEqual(
      expect.arrayContaining([
        "extensions/diffs",
        "extensions/diffs-language-pack",
        "extensions/slack",
        "extensions/sms",
        "extensions/mxc",
      ]),
    );
    expect(packageDirs).not.toContain("extensions/whatsapp");
    expect(
      packageDirs.every((packageDir) => excludedPluginIds.has(packageDir.split("/").at(-1) ?? "")),
    ).toBe(true);
  });

  it("leaves Docker-selected external plugin compilation on the unified build path", () => {
    expect(
      listExternalPluginLocalDistPackageDirs({
        env: {
          ...process.env,
          [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack",
        },
      }),
    ).toEqual([]);
  });

  it("performs no writes when Docker owns the selected build", async () => {
    await expect(
      buildExternalPluginLocalDist({
        env: {
          ...process.env,
          [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack",
        },
        logLevel: "silent",
      }),
    ).resolves.toMatchObject({ pluginDirs: [] });
  });
});
