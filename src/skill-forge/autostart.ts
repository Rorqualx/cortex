import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const LAUNCH_AGENT_LABEL = "com.openclaw.skill-forge";
export const DEFAULT_INTERVAL_MINUTES = 5;
const MIN_INTERVAL_SECONDS = 60;

export type AutostartPlatform = "darwin" | "linux" | "other";

export type AutostartInstallParams = {
  intervalMinutes?: number;
  openclawBin?: string;
  nodeBin?: string;
  plistDir?: string;
  logPath?: string;
  daemonFlags?: ReadonlyArray<string>;
};

export type AutostartInstallResult = {
  platform: AutostartPlatform;
  plistPath?: string;
  cronExpression?: string;
  intervalSeconds: number;
  label: string;
};

export type AutostartUninstallResult = {
  platform: AutostartPlatform;
  removed: boolean;
  loadedRemoved: boolean;
};

export type AutostartStatus = {
  platform: AutostartPlatform;
  installed: boolean;
  plistPath?: string;
  intervalSeconds?: number;
  loaded?: boolean;
};

function resolvePlatform(): AutostartPlatform {
  if (process.platform === "darwin") {
    return "darwin";
  }
  if (process.platform === "linux") {
    return "linux";
  }
  return "other";
}

function resolveLaunchAgentPlistPath(plistDir?: string): string {
  const dir = plistDir ?? path.join(os.homedir(), "Library", "LaunchAgents");
  return path.join(dir, `${LAUNCH_AGENT_LABEL}.plist`);
}

function resolveNodeBin(override?: string): string {
  return override ?? process.execPath;
}

function resolveOpenclawBin(override?: string): string {
  if (override) {
    return override;
  }
  // When invoked via openclaw CLI, argv[1] is openclaw.mjs.
  // Fallback: assume "openclaw" is on PATH.
  return process.argv[1] ?? "openclaw";
}

function resolveLogPath(override?: string): string {
  if (override) {
    return override;
  }
  return path.join(os.homedir(), ".openclaw", "logs", "skill-forge-cron.log");
}

function resolveGuiTarget(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  return `gui/${uid}`;
}

function normalizeIntervalSeconds(intervalMinutes: number): number {
  const seconds = Math.trunc(intervalMinutes * 60);
  return Math.max(MIN_INTERVAL_SECONDS, seconds);
}

export function buildSkillForgeLaunchdPlist(params: {
  label: string;
  nodeBin: string;
  openclawBin: string;
  intervalSeconds: number;
  logPath: string;
  daemonFlags?: ReadonlyArray<string>;
}): string {
  const escape = (value: string): string =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  const extraFlagLines = (params.daemonFlags ?? [])
    .map((flag) => `    <string>${escape(flag)}</string>`)
    .join("\n");
  const programArguments = [
    `    <string>${escape(params.nodeBin)}</string>`,
    `    <string>${escape(params.openclawBin)}</string>`,
    `    <string>skill-forge</string>`,
    `    <string>daemon</string>`,
    `    <string>--once</string>`,
    ...(extraFlagLines ? [extraFlagLines] : []),
  ].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(params.label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>StartInterval</key>
  <integer>${params.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escape(params.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(params.logPath)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

async function bootstrapLaunchAgent(plistPath: string): Promise<void> {
  try {
    await exec("launchctl", ["bootstrap", resolveGuiTarget(), plistPath]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/Service is already loaded|already exists|Input\/output error/iu.test(detail)) {
      return;
    }
    throw error;
  }
}

async function bootoutLaunchAgent(): Promise<boolean> {
  try {
    await exec("launchctl", ["bootout", `${resolveGuiTarget()}/${LAUNCH_AGENT_LABEL}`]);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/Could not find service|No such process|Input\/output error/iu.test(detail)) {
      return false;
    }
    throw error;
  }
}

async function isLaunchAgentLoaded(): Promise<boolean> {
  try {
    await exec("launchctl", ["print", `${resolveGuiTarget()}/${LAUNCH_AGENT_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

async function installLaunchAgent(params: AutostartInstallParams): Promise<AutostartInstallResult> {
  const intervalSeconds = normalizeIntervalSeconds(
    params.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
  );
  const plistPath = resolveLaunchAgentPlistPath(params.plistDir);
  const logPath = resolveLogPath(params.logPath);
  await fsp.mkdir(path.dirname(plistPath), { recursive: true });
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  const plist = buildSkillForgeLaunchdPlist({
    label: LAUNCH_AGENT_LABEL,
    nodeBin: resolveNodeBin(params.nodeBin),
    openclawBin: resolveOpenclawBin(params.openclawBin),
    intervalSeconds,
    logPath,
    daemonFlags: params.daemonFlags,
  });
  await fsp.writeFile(plistPath, plist, "utf8");
  await fsp.chmod(plistPath, 0o644);
  await bootstrapLaunchAgent(plistPath);
  return {
    platform: "darwin",
    plistPath,
    intervalSeconds,
    label: LAUNCH_AGENT_LABEL,
  };
}

async function uninstallLaunchAgent(plistDir?: string): Promise<AutostartUninstallResult> {
  const plistPath = resolveLaunchAgentPlistPath(plistDir);
  const loadedRemoved = await bootoutLaunchAgent();
  let removed = false;
  try {
    await fsp.unlink(plistPath);
    removed = true;
  } catch {
    // No plist on disk — nothing to remove.
  }
  return { platform: "darwin", removed, loadedRemoved };
}

async function statusLaunchAgent(plistDir?: string): Promise<AutostartStatus> {
  const plistPath = resolveLaunchAgentPlistPath(plistDir);
  let intervalSeconds: number | undefined;
  let installed = false;
  try {
    const content = await fsp.readFile(plistPath, "utf8");
    installed = true;
    const match = content.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/u);
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed)) {
        intervalSeconds = parsed;
      }
    }
  } catch {
    // Not present — installed stays false.
  }
  return {
    platform: "darwin",
    installed,
    plistPath,
    intervalSeconds,
    loaded: installed ? await isLaunchAgentLoaded() : false,
  };
}

export async function installAutostart(
  params: AutostartInstallParams = {},
): Promise<AutostartInstallResult> {
  const platform = resolvePlatform();
  if (platform === "darwin") {
    return installLaunchAgent(params);
  }
  throw new Error(
    `skill-forge autostart on platform '${process.platform}' is not implemented yet. Use 'openclaw skill-forge daemon --once' via your OS scheduler (crontab on Linux, Task Scheduler on Windows).`,
  );
}

export async function uninstallAutostart(
  params: {
    plistDir?: string;
  } = {},
): Promise<AutostartUninstallResult> {
  const platform = resolvePlatform();
  if (platform === "darwin") {
    return uninstallLaunchAgent(params.plistDir);
  }
  return { platform, removed: false, loadedRemoved: false };
}

export async function autostartStatus(
  params: {
    plistDir?: string;
  } = {},
): Promise<AutostartStatus> {
  const platform = resolvePlatform();
  if (platform === "darwin") {
    return statusLaunchAgent(params.plistDir);
  }
  return { platform, installed: false };
}
