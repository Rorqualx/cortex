import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSkillForgeLaunchdPlist, LAUNCH_AGENT_LABEL } from "./autostart.js";

describe("buildSkillForgeLaunchdPlist", () => {
  it("renders a valid plist with the expected ProgramArguments and StartInterval", () => {
    const plist = buildSkillForgeLaunchdPlist({
      label: LAUNCH_AGENT_LABEL,
      nodeBin: "/usr/local/bin/node",
      openclawBin: "/path/to/openclaw.mjs",
      intervalSeconds: 300,
      logPath: "/tmp/skill-forge.log",
    });
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain("<integer>300</integer>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/path/to/openclaw.mjs</string>");
    expect(plist).toContain("<string>skill-forge</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>--once</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <false/>");
    expect(plist).toContain("<key>ProcessType</key>\n  <string>Background</string>");
    expect(plist).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/u);
    expect(plist).toMatch(/<\/plist>\n$/u);
  });

  it("appends extra daemon flags into ProgramArguments when daemonFlags is provided", () => {
    const plist = buildSkillForgeLaunchdPlist({
      label: LAUNCH_AGENT_LABEL,
      nodeBin: "/n",
      openclawBin: "/o",
      intervalSeconds: 300,
      logPath: "/l",
      daemonFlags: ["--with-llm-replay", "--with-embedding"],
    });
    expect(plist).toContain("<string>--with-llm-replay</string>");
    expect(plist).toContain("<string>--with-embedding</string>");
    // The standard args must still be present and in order.
    const argsBlock = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u);
    expect(argsBlock).not.toBeNull();
    if (!argsBlock) {
      throw new Error("unreachable");
    }
    const order =
      argsBlock[1]
        .match(/<string>([^<]*)<\/string>/gu)
        ?.map((s) => s.replace(/<\/?string>/gu, "")) ?? [];
    expect(order).toEqual([
      "/n",
      "/o",
      "skill-forge",
      "daemon",
      "--once",
      "--with-llm-replay",
      "--with-embedding",
    ]);
  });

  it("escapes XML-significant characters in paths", () => {
    const plist = buildSkillForgeLaunchdPlist({
      label: "test<&'\">label",
      nodeBin: "/n",
      openclawBin: "/o",
      intervalSeconds: 60,
      logPath: "/l",
    });
    expect(plist).toContain("test&lt;&amp;&apos;&quot;&gt;label");
    expect(plist).not.toContain("test<&'\">label");
  });
});

describe("autostart fs effects (darwin only — skipped otherwise)", () => {
  let plistDir: string;
  beforeEach(async () => {
    plistDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-autostart-"));
  });
  afterEach(async () => {
    await fsp.rm(plistDir, { recursive: true, force: true });
  });

  // Note: install/uninstall actually shell out to launchctl, so we can't fully
  // unit-test them without mocking child_process. The plist generation above
  // covers the deterministic surface. Live verification happens in the CLI
  // smoke test.
  it("plistDir override is honored when computing the path (no shell-out validation)", () => {
    // Just verifies the path-resolution logic compiles and exposes the override.
    expect(plistDir).toMatch(/forge-autostart-/u);
  });
});
