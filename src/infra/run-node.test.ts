// Tests node process runner lifecycle and captured output.
import { execFileSync, spawnSync as realSpawnSync, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  bundledDistPluginFile,
  bundledPluginFile,
  bundledPluginRoot,
} from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it as baseIt, onTestFinished, vi } from "vitest";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import * as liveGatewayDistFence from "../../scripts/lib/live-gateway-dist-fence.mts";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata-paths.mts";
import {
  writeBuildStamp,
  writeRuntimePostBuildStamp,
} from "../../scripts/lib/local-build-metadata.mts";
import {
  UPDATE_COMPATIBILITY_INVENTORY_FILE,
  writeUpdateCompatibilityChunks,
} from "../../scripts/lib/update-compat-chunks.mts";
import {
  acquireRunNodeBuildLock,
  resolveBuildRequirement,
  resolveRuntimePostBuildRequirement,
  runNodeMain,
  stripGatewayServiceMarkers,
} from "../../scripts/run-node.mts";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  ROOT_SRC,
  ROOT_TSCONFIG,
  ROOT_PACKAGE,
  ROOT_TSDOWN,
  BUILD_STAMP,
  RUNTIME_POSTBUILD_STAMP,
  DIST_CHANNEL_CATALOG,
  QA_LAB_PLUGIN_SDK_ENTRY,
  QA_RUNTIME_PLUGIN_SDK_ENTRY,
  EXTENSION_SRC,
  EXTENSION_EXTRA_SRC,
  EXTENSION_MANIFEST,
  EXTENSION_PACKAGE,
  EXTENSION_README,
  DIST_EXTENSION_SRC,
  NEW_TIME,
  createExitedProcess,
  createPipedExitedProcess,
  createFakeProcess,
  skipRuntimePostBuild,
  firstMockCall,
  writeRuntimePostBuildScaffold,
  expectedBuildSpawn,
  statusCommandSpawn,
  resolvePath,
  isTsxScriptArgs,
  touchProjectFiles,
  setupTrackedProject,
  setupStampedProject,
  createSpawnRecorder,
  createCurrentGitSpawnRecorder,
  createBuildRequirementDeps,
  trackProjectWithGit,
  runNodeCommand,
  runStatusCommand,
  runQaCommand,
} from "../../test/scripts/run-node.test-support.js";
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "../../test/scripts/update-compat-chunks.test-support.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

const it = baseIt.extend<{ tmp: string }>({
  tmp: async ({ task: _task }, use) => {
    await withTestDir({ prefix: "openclaw-run-node-" }, use);
  },
});

// Production run-node consults the live managed Gateway dist fence; keep these
// fixtures independent of any Gateway running on the host.
beforeEach(() => {
  const fence = vi
    .spyOn(liveGatewayDistFence, "resolveLiveManagedGatewayDistFence")
    .mockResolvedValue({ refuse: false });
  onTestFinished(() => fence.mockRestore());
});

describe("run-node script", () => {
  it.for([
    { args: ["--profile", "ci", "qa", "mantis", "run"], mantis: true },
    { args: ["--profile", "qa", "mantis", "run"], mantis: false },
    { args: ["status", "qa", "mantis", "run"], mantis: false },
  ])(
    "grants Mantis lifecycle IPC only to the parsed command: %j",
    async ({ args, mantis }, { tmp }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
      const fakeProcess = Object.assign(createFakeProcess(), { stdin: { isTTY: true } });
      const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      const { promise: childSpawned, resolve: markChildSpawned } = createDeferred();
      const spawn = vi.fn((_cmd: string, childArgs: string[], _options: unknown) => {
        if (!childArgs.includes("openclaw.mjs")) {
          return createExitedProcess(0);
        }
        markChildSpawned();
        return child;
      });
      const outcome = runNodeCommand(tmp, {
        args,
        process: fakeProcess,
        spawn,
        runRuntimePostBuild: skipRuntimePostBuild,
      });
      // Lifecycle listeners attach in the spawn call stack, after async build/postbuild work.
      await Promise.race([childSpawned, outcome]);
      try {
        expect(child.listenerCount("exit")).toBe(1);
        vi.useFakeTimers();
        child.emit("message", { type: "openclaw:shutdown-grace", graceMs: 120_000 });
        fakeProcess.emit("SIGTERM");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(child.kill.mock.calls).toEqual(mantis ? [["SIGTERM"]] : [["SIGTERM"], ["SIGKILL"]]);
        if (mantis) {
          await vi.advanceTimersByTimeAsync(115_000);
          expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
        }
      } finally {
        child.emit("exit", 0, null);
        await outcome;
        vi.useRealTimers();
      }
      expect(await outcome).toBe(143);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
    },
  );

  const ROOT_SRC = "src/index.ts";
  const ROOT_TSCONFIG = "tsconfig.json";
  const ROOT_PACKAGE = "package.json";
  const ROOT_TSDOWN = "tsdown.config.ts";
  const DIST_ENTRY = "dist/entry.js";
  const BUILD_STAMP = `dist/${BUILD_STAMP_FILE}`;
  const RUNTIME_POSTBUILD_STAMP = `dist/${RUNTIME_POSTBUILD_STAMP_FILE}`;
  const DIST_PLUGIN_SDK_CORE = "dist/plugin-sdk/core.js";
  const DIST_CHANNEL_CATALOG = "dist/channel-catalog.json";
  const DIST_BUILD_INFO = "dist/build-info.json";
  const DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT = "dist/shared-Y6bNiw2w.js";
  const DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT = "dist/shared-DTaQo6Hi.js";
  const DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_0229A108 = "dist/shared-1Uyqkfns.js";
  const DIST_LEGACY_CLI_EXIT_COMPAT = "dist/memory-state-CcqRgDZU.js";
  const DIST_LEGACY_CLI_EXIT_COMPAT_ALT = "dist/memory-state-DwGdReW4.js";
  const QA_LAB_PLUGIN_SDK_ENTRY = "dist/plugin-sdk/qa-lab.js";
  const QA_RUNTIME_PLUGIN_SDK_ENTRY = "dist/plugin-sdk/qa-runtime.js";
  const EXTENSION_INDEX = bundledPluginFile("demo", "index.ts");
  const EXTENSION_SRC = bundledPluginFile("demo", "src/index.ts");
  const EXTENSION_EXTRA_SRC = bundledPluginFile("demo", "src/extra.ts");
  const EXTENSION_MANIFEST = bundledPluginFile("demo", "openclaw.plugin.json");
  const EXTENSION_PACKAGE = bundledPluginFile("demo", "package.json");
  const EXTENSION_README = bundledPluginFile("demo", "README.md");
  const DIST_EXTENSION_INDEX = bundledDistPluginFile("demo", "index.js");
  const DIST_EXTENSION_SRC = bundledDistPluginFile("demo", "src/index.js");
  const DIST_OPENCLAW_ALIAS_PACKAGE = "dist/extensions/node_modules/openclaw/package.json";
  const DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE =
    "dist/extensions/node_modules/openclaw/plugin-sdk/core.js";
  const DIST_EXTENSION_MANIFEST = bundledDistPluginFile("demo", "openclaw.plugin.json");
  const DIST_EXTENSION_PACKAGE = bundledDistPluginFile("demo", "package.json");

  const OLD_TIME = new Date("2026-03-13T10:00:00.000Z");
  const BUILD_TIME = new Date("2026-03-13T12:00:00.000Z");
  const NEW_TIME = new Date("2026-03-13T12:00:01.000Z");

  const BASE_PROJECT_FILES = {
    [ROOT_TSCONFIG]: "{}\n",
    [ROOT_PACKAGE]: '{"name":"openclaw-test"}\n',
    [DIST_ENTRY]: "console.log('built');\n",
    [BUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n',
  } as const;

  function createExitedProcess(code: number | null, signal: string | null = null) {
    return {
      on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
        if (event === "exit") {
          queueMicrotask(() => cb(code, signal));
        }
        return undefined;
      },
    };
  }

  function createPipedExitedProcess(params: {
    code?: number | null;
    signal?: string | null;
    stderr?: string;
    stdout?: string;
  }) {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    return {
      stdout,
      stderr,
      on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
        if (event === "exit") {
          queueMicrotask(() => {
            if (params.stdout) {
              stdout.emit("data", Buffer.from(params.stdout));
            }
            if (params.stderr) {
              stderr.emit("data", Buffer.from(params.stderr));
            }
            cb(params.code ?? 0, params.signal ?? null);
          });
        }
        return undefined;
      },
    };
  }

  function createFakeProcess() {
    return Object.assign(new EventEmitter(), {
      pid: 4242,
      execPath: process.execPath,
    }) as unknown as NodeJS.Process;
  }

  // Launcher plumbing tests do not need the real runtime artifact copier.
  async function skipRuntimePostBuild(): Promise<void> {}

  async function syncBundledPluginMetadata(params?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  }): Promise<void> {
    copyBundledPluginMetadata({ cwd: params?.cwd, env: params?.env });
  }

  function firstMockCall<T extends unknown[]>(mock: { mock: { calls: T[] } }): T | undefined {
    return mock.mock.calls[0];
  }

  async function writeRuntimePostBuildScaffold(tmp: string): Promise<void> {
    await fs.mkdir(path.join(tmp, "extensions"), { recursive: true });
    await writeProjectFiles(tmp, {
      [DIST_PLUGIN_SDK_CORE]: "export const core = true;\n",
      [DIST_CHANNEL_CATALOG]: '{"entries":[]}\n',
      [DIST_BUILD_INFO]: '{"buildId":"test-build"}\n',
      [DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT]: "export function resolveNodeRunner() {}\n",
      [DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT]: "export function resolveNodeRunner() {}\n",
      [DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_0229A108]: "export function resolveNodeRunner() {}\n",
      [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
      [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]: "export function hasMemoryRuntime() { return false; }\n",
      [DIST_OPENCLAW_ALIAS_PACKAGE]:
        '{"name":"openclaw","type":"module","exports":{"./plugin-sdk/core":"./plugin-sdk/core.js"}}\n',
      [DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE]: "export * from '../../../../plugin-sdk/core.js';\n",
    });
    writeUpdateCompatibilityBuildFixture(tmp);
    writeUpdateCompatibilityChunks({
      distDir: path.join(tmp, "dist"),
      sourceDir: tmp,
      inventory: previousReleaseInventory,
    });
    await touchProjectFiles(
      tmp,
      [
        DIST_CHANNEL_CATALOG,
        DIST_BUILD_INFO,
        DIST_PLUGIN_SDK_CORE,
        DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT,
        DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_ALT,
        DIST_LEGACY_UPDATE_NODE_RUNNER_COMPAT_0229A108,
        `dist/${UPDATE_COMPATIBILITY_INVENTORY_FILE}`,
        ...previousReleaseInventory.releases.flatMap((release) =>
          release.chunks.map((chunk) => `dist/${chunk.path}`),
        ),
        DIST_LEGACY_CLI_EXIT_COMPAT,
        DIST_LEGACY_CLI_EXIT_COMPAT_ALT,
        DIST_OPENCLAW_ALIAS_PACKAGE,
        DIST_OPENCLAW_ALIAS_PLUGIN_SDK_CORE,
      ],
      BUILD_TIME,
    );
  }

  function expectedBuildSpawn() {
    return [process.execPath, "--import", "tsx", "scripts/build-all.mts", "qaRuntime"];
  }

  function statusCommandSpawn() {
    return [process.execPath, "openclaw.mjs", "status"];
  }

  function resolvePath(tmp: string, relativePath: string) {
    return path.join(tmp, relativePath);
  }

  function isTsxScriptArgs(args: string[], scriptPath: string): boolean {
    return args[0] === "--import" && args[1] === "tsx" && args[2] === scriptPath;
  }

  async function writeProjectFiles(tmp: string, files: Record<string, string>) {
    await Promise.all(
      Object.entries(files).map(async ([relativePath, contents]) => {
        const absolutePath = resolvePath(tmp, relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, contents, "utf-8");
      }),
    );
  }

  async function touchProjectFiles(tmp: string, relativePaths: string[], time: Date) {
    await Promise.all(
      relativePaths.map(async (relativePath) => {
        const absolutePath = resolvePath(tmp, relativePath);
        await fs.utimes(absolutePath, time, time);
      }),
    );
  }

  async function setupTrackedProject(
    tmp: string,
    options: {
      files?: Record<string, string>;
      oldPaths?: string[];
      buildPaths?: string[];
      newPaths?: string[];
    } = {},
  ) {
    await writeRuntimePostBuildScaffold(tmp);
    await writeProjectFiles(tmp, {
      ...BASE_PROJECT_FILES,
      ...options.files,
    });
    await touchProjectFiles(tmp, options.oldPaths ?? [], OLD_TIME);
    await touchProjectFiles(tmp, options.buildPaths ?? [], BUILD_TIME);
    await touchProjectFiles(tmp, options.newPaths ?? [], NEW_TIME);
  }

  async function setupStampedProject(
    tmp: string,
    options: {
      files?: Record<string, string>;
      oldPaths?: string[];
      newPaths?: string[];
      rootSource?: boolean;
      trackConfig?: boolean;
    },
  ): Promise<void> {
    const files = {
      ...(options.rootSource === false ? {} : { [ROOT_SRC]: "export const value = 1;\n" }),
      ...options.files,
    };
    const excludedPaths = new Set([...(options.oldPaths ?? []), ...(options.newPaths ?? [])]);
    const buildPaths = [
      ...Object.keys(files).filter((filePath) => !excludedPaths.has(filePath)),
      ...(options.trackConfig ? [ROOT_TSCONFIG, ROOT_PACKAGE] : []),
      DIST_ENTRY,
      BUILD_STAMP,
    ];
    await setupTrackedProject(tmp, {
      files,
      ...(options.oldPaths ? { oldPaths: options.oldPaths } : {}),
      buildPaths,
      ...(options.newPaths ? { newPaths: options.newPaths } : {}),
    });
  }

  function createSpawnRecorder(
    options: {
      gitHead?: string;
      gitStatus?: string;
    } = {},
  ) {
    const spawnCalls: string[][] = [];
    const spawn = (cmd: string, args: string[]) => {
      spawnCalls.push([cmd, ...args]);
      return createExitedProcess(0);
    };
    const spawnSync = (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse" && options.gitHead !== undefined) {
        return { status: 0, stdout: options.gitHead };
      }
      if (cmd === "git" && args[0] === "status" && options.gitStatus !== undefined) {
        return { status: 0, stdout: options.gitStatus };
      }
      return { status: 1, stdout: "" };
    };
    return { spawnCalls, spawn, spawnSync };
  }

  function createCurrentGitSpawnRecorder(options: { gitHead?: string; gitStatus?: string } = {}) {
    return createSpawnRecorder({ gitHead: "abc123\n", gitStatus: "", ...options });
  }

  function createBuildRequirementDeps(
    tmp: string,
    options: {
      gitHead?: string;
      gitStatus?: string;
      env?: Record<string, string>;
    } = {},
  ) {
    const { spawnSync } = createSpawnRecorder({
      gitHead: options.gitHead,
      gitStatus: options.gitStatus,
    });
    // Strip ambient gateway-service markers so suppression is opt-in per test and
    // outcomes never depend on whether the suite runs inside a managed gateway.
    const baseEnv = stripGatewayServiceMarkers(process.env);
    return {
      cwd: tmp,
      env: {
        ...baseEnv,
        ...options.env,
      },
      fs: fsSync,
      spawnSync,
      distRoot: path.join(tmp, "dist"),
      distEntry: path.join(tmp, DIST_ENTRY),
      buildStampPath: path.join(tmp, BUILD_STAMP),
      runtimePostBuildStampPath: path.join(tmp, RUNTIME_POSTBUILD_STAMP),
      sourceRoots: [path.join(tmp, "src"), path.join(tmp, bundledPluginRoot("demo"))].map(
        (sourceRoot) => ({
          name: path.relative(tmp, sourceRoot).replaceAll("\\", "/"),
          path: sourceRoot,
        }),
      ),
      configFiles: [ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN].map((filePath) =>
        path.join(tmp, filePath),
      ),
    };
  }

  async function trackProjectWithGit(tmp: string) {
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", `core.hooksPath=${path.join(tmp, ".git", "disabled-hooks")}`, ...args],
        { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    git("init", "--quiet", "--template=");
    git("config", "core.quotePath", "true");
    git("add", "--all");
    git(
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=test@openclaw.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "test: track runner fixture",
    );
    writeBuildStamp({ cwd: tmp, spawnSync: realSpawnSync });
    writeRuntimePostBuildStamp({ cwd: tmp, spawnSync: realSpawnSync });
    await touchProjectFiles(tmp, [BUILD_STAMP, RUNTIME_POSTBUILD_STAMP], BUILD_TIME);
    return {
      git,
      deps: { ...createBuildRequirementDeps(tmp), env: {}, spawnSync: realSpawnSync },
    };
  }

  type RunNodeTestOptions = NonNullable<Parameters<typeof runNodeMain>[0]> & {
    stdout?: NodeJS.WriteStream;
  };
  type RunNodeResult = Awaited<ReturnType<typeof runNodeMain>>;

  async function runNodeCommand(tmp: string, options: RunNodeTestOptions): Promise<RunNodeResult> {
    const { env, ...overrides } = options;
    return await runNodeMain({
      cwd: tmp,
      args: ["status"],
      ...overrides,
      env: { ...process.env, OPENCLAW_RUNNER_LOG: "0", ...env },
      execPath: process.execPath,
      platform: options.platform ?? process.platform,
    } as RunNodeTestOptions);
  }

  type RunCommandParams = {
    tmp: string;
    args?: string[];
    spawn: (cmd: string, args: string[]) => ReturnType<typeof createExitedProcess>;
    spawnSync?: (cmd: string, args: string[]) => { status: number; stdout: string };
    stderr?: NodeJS.WriteStream;
    env?: Record<string, string>;
    runRuntimePostBuild?: (params?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
    }) => void | Promise<void>;
  };

  async function runStatusCommand({ tmp, ...options }: RunCommandParams): Promise<RunNodeResult> {
    return await runNodeCommand(tmp, options);
  }

  async function runQaCommand(params: RunCommandParams): Promise<RunNodeResult> {
    return await runStatusCommand({
      ...params,
      args: ["qa", "suite", "--transport", "qa-channel", "--provider-mode", "mock-openai"],
    });
  }

  async function expectManifestId(tmp: string, relativePath: string, id: string) {
    const manifest = JSON.parse(await fs.readFile(resolvePath(tmp, relativePath), "utf-8")) as {
      id?: unknown;
    };
    expect(manifest.id).toBe(id);
  }

  describe("run-node script", () => {
    it("starts the CLI only after the canonical runtime build completes", async ({ tmp }) => {
      const build = new EventEmitter();
      const fakeProcess = createFakeProcess();
      const { promise: buildSpawned, resolve: markBuildSpawned } = createDeferred();
      const spawn = vi.fn((_cmd: string, args: string[]) => {
        if (!isTsxScriptArgs(args, "scripts/build-all.mts")) {
          return createExitedProcess(0);
        }
        markBuildSpawned();
        return build;
      });
      const runRuntimePostBuild = vi.fn();
      const result = runNodeCommand(tmp, {
        spawn,
        process: fakeProcess,
        env: { OPENCLAW_FORCE_BUILD: "1" },
        runRuntimePostBuild,
      });
      await Promise.race([buildSpawned, result]);
      expect(spawn).toHaveBeenCalledOnce();
      const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");
      expect(fsSync.existsSync(lockDir)).toBe(true);
      expect(fakeProcess.listenerCount("exit")).toBe(1);
      build.emit("exit", 0, null);

      expect(await result).toBe(0);
      expect(spawn.mock.calls.map(([cmd, args]) => [cmd].concat(args))).toEqual([
        expectedBuildSpawn(),
        statusCommandSpawn(),
      ]);
      // The canonical profile owns metadata and both stamps; the local runner
      // only invokes postbuild directly on its separate metadata-only path.
      expect(runRuntimePostBuild).not.toHaveBeenCalled();
      expect(fsSync.existsSync(lockDir)).toBe(false);
      expect(fakeProcess.listenerCount("exit")).toBe(0);
    });

    it("routes local build stdout to stderr before JSON command output", async ({ tmp }) => {
      await writeRuntimePostBuildScaffold(tmp);
      const outputPath = path.join(tmp, ".artifacts", "run-node", "output.log");
      const spawn = (_cmd: string, args: string[]) => {
        if (isTsxScriptArgs(args, "scripts/build-all.mts")) {
          return createPipedExitedProcess({
            stdout: "asset stdout\nbuild stdout\n",
            stderr: "asset stderr\nbuild stderr\n",
          });
        }
        return createPipedExitedProcess({ stdout: '{"plugins":[]}\n' });
      };
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const stdout = {
        write: (chunk: string | Buffer) => {
          stdoutChunks.push(String(chunk));
          return true;
        },
      } as unknown as NodeJS.WriteStream;
      const exitCode = await runNodeCommand(tmp, {
        args: ["plugins", "list", "--json"],
        env: { OPENCLAW_FORCE_BUILD: "1", OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath },
        spawn,
        stdout,
        stderr: { write: (chunk) => stderrChunks.push(String(chunk)) },
        runRuntimePostBuild: skipRuntimePostBuild,
      });

      expect(exitCode).toBe(0);
      expect(stdoutChunks.join("")).toBe('{"plugins":[]}\n');
      expect(stderrChunks.join("")).toContain("asset stdout\n");
      expect(stderrChunks.join("")).toContain("asset stderr\n");
      expect(stderrChunks.join("")).toContain("build stdout\n");
      expect(stderrChunks.join("")).toContain("build stderr\n");
    });

    it("routes sync I/O trace stderr blocks to the output log without flooding stderr", async ({
      tmp,
    }) => {
      await setupTrackedProject(tmp);
      const outputPath = path.join(tmp, ".artifacts", "gateway-watch-profiles", "output.log");
      const childStderr = [
        "normal before\n",
        "(node:12345) WARNING: Detected use of sync API\n",
        "    at statSync (node:fs:1739:25)\n",
        "    at loadConfig (/repo/src/config.ts:1:1)\n",
        "\n",
        "normal after\n",
      ].join("");
      const spawn = (_cmd: string, args: string[]) =>
        createPipedExitedProcess({
          stderr: args[0] === "openclaw.mjs" ? childStderr : "",
        });
      const stderrChunks: string[] = [];
      const exitCode = await runNodeCommand(tmp, {
        env: {
          OPENCLAW_RUN_NODE_FILTER_SYNC_IO_STDERR: "1",
          OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath,
        },
        spawn,
        stderr: { write: (chunk) => stderrChunks.push(String(chunk)) },
        runRuntimePostBuild: skipRuntimePostBuild,
      });

      expect(exitCode).toBe(0);
      const terminalStderr = stderrChunks.join("");
      expect(terminalStderr).toContain("normal before\n");
      expect(terminalStderr).toContain("normal after\n");
      expect(terminalStderr).not.toContain("Detected use of sync API");
      expect(terminalStderr).not.toContain("statSync");
      await expect(fs.readFile(outputPath, "utf-8")).resolves.toContain(childStderr);
    });

    it("adds Node CPU profiling flags to the launched OpenClaw child when requested", async ({
      tmp,
    }) => {
      await setupStampedProject(tmp, {
        files: {
          [DIST_CHANNEL_CATALOG]: '{"entries":[]}\n',
          [DIST_LEGACY_CLI_EXIT_COMPAT]: "export function hasMemoryRuntime() { return false; }\n",
          [DIST_LEGACY_CLI_EXIT_COMPAT_ALT]:
            "export function hasMemoryRuntime() { return false; }\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
      });
      const profileDir = path.join(tmp, ".artifacts", "profiles");
      const spawnCalls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const spawn = (_cmd: string, args: string[], options?: unknown) => {
        const opts = options as { env?: NodeJS.ProcessEnv } | undefined;
        spawnCalls.push({ args, env: { ...opts?.env } });
        return createExitedProcess(0);
      };
      const { spawnSync } = createCurrentGitSpawnRecorder();

      const exitCode = await runNodeCommand(tmp, {
        env: { OPENCLAW_RUN_NODE_CPU_PROF_DIR: ".artifacts/profiles" },
        spawn,
        spawnSync,
        runRuntimePostBuild: skipRuntimePostBuild,
        process: createFakeProcess(),
      });

      expect(exitCode).toBe(0);
      const childArgs = spawnCalls.at(-1)?.args ?? [];
      expect(childArgs[0]).toBe("--cpu-prof");
      expect(childArgs[1]).toBe(`--cpu-prof-dir=${profileDir}`);
      expect(childArgs[2]).toMatch(
        /^--cpu-prof-name=openclaw-status-4242-\d{4}-\d{2}-\d{2}T.*\.cpuprofile$/,
      );
      expect(childArgs.slice(3)).toEqual(["openclaw.mjs", "status"]);
      expect(spawnCalls.at(-1)?.env.OPENCLAW_RUN_NODE_CPU_PROF_DIR).toBe(profileDir);
      expect(fsSync.existsSync(profileDir)).toBe(true);
    });

    it("rotates old Node CPU profiles when a retention cap is set", async ({ tmp }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
      const profileDir = path.join(tmp, ".artifacts", "profiles");
      fsSync.mkdirSync(profileDir, { recursive: true });
      const oldProfiles = [
        "openclaw-status-oldest.cpuprofile",
        "openclaw-status-middle.cpuprofile",
        "openclaw-status-newest.cpuprofile",
      ];
      for (const [index, name] of oldProfiles.entries()) {
        const filePath = path.join(profileDir, name);
        fsSync.writeFileSync(filePath, "{}");
        const mtime = new Date(1_700_000_000_000 + index * 1000);
        fsSync.utimesSync(filePath, mtime, mtime);
      }
      fsSync.writeFileSync(path.join(profileDir, "openclaw-models-old.cpuprofile"), "{}");

      const spawn = () => createExitedProcess(0);
      const { spawnSync } = createCurrentGitSpawnRecorder();

      const exitCode = await runNodeCommand(tmp, {
        env: {
          OPENCLAW_RUN_NODE_CPU_PROF_DIR: ".artifacts/profiles",
          OPENCLAW_RUN_NODE_CPU_PROF_MAX_FILES: "2",
        },
        spawn,
        spawnSync,
        runRuntimePostBuild: skipRuntimePostBuild,
        process: createFakeProcess(),
      });

      expect(exitCode).toBe(0);
      expect(
        fsSync.existsSync(
          path.join(profileDir, expectDefined(oldProfiles[0], "oldProfiles[0] test invariant")),
        ),
      ).toBe(false);
      expect(
        fsSync.existsSync(
          path.join(profileDir, expectDefined(oldProfiles[1], "oldProfiles[1] test invariant")),
        ),
      ).toBe(false);
      expect(
        fsSync.existsSync(
          path.join(profileDir, expectDefined(oldProfiles[2], "oldProfiles[2] test invariant")),
        ),
      ).toBe(true);
      expect(fsSync.existsSync(path.join(profileDir, "openclaw-models-old.cpuprofile"))).toBe(true);
    });

    it("adds Node sync I/O tracing flag to the launched OpenClaw child when requested", async ({
      tmp,
    }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
      const spawnCalls: string[][] = [];
      const spawn = (_cmd: string, args: string[]) => {
        spawnCalls.push(args);
        return createExitedProcess(0);
      };
      const { spawnSync } = createCurrentGitSpawnRecorder();

      const exitCode = await runNodeCommand(tmp, {
        args: ["gateway", "--force"],
        env: { OPENCLAW_TRACE_SYNC_IO: "1" },
        spawn,
        spawnSync,
        runRuntimePostBuild: skipRuntimePostBuild,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls.at(-1)).toEqual(["--trace-sync-io", "openclaw.mjs", "gateway", "--force"]);
    });

    it("surfaces generic output log stream errors", async ({ tmp }) => {
      await setupTrackedProject(tmp);
      const outputPath = path.join(tmp, ".artifacts", "qa-e2e", "matrix", "output.log");
      await fs.mkdir(outputPath, { recursive: true });
      const spawn = () => createPipedExitedProcess({ stdout: "child stdout\n" });
      const stderrChunks: string[] = [];
      const mutedStream = {
        write: (chunk: string | Buffer) => {
          stderrChunks.push(String(chunk));
          return true;
        },
      } as unknown as NodeJS.WriteStream;

      const exitCode = await runNodeCommand(tmp, {
        env: { OPENCLAW_RUN_NODE_OUTPUT_LOG: outputPath },
        spawn,
        stderr: mutedStream,
        stdout: mutedStream,
        runRuntimePostBuild: skipRuntimePostBuild,
      });

      expect(exitCode).toBe(1);
      expect(stderrChunks.join("")).toContain("Failed to write output log");
    });

    it("does not mutate Matrix QA args when no generic output log is requested", async ({
      tmp,
    }) => {
      await setupTrackedProject(tmp);
      const spawnCalls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const spawn = (_cmd: string, args: string[], options?: unknown) => {
        const opts = options as { env?: NodeJS.ProcessEnv } | undefined;
        spawnCalls.push({ args, env: { ...opts?.env } });
        return createPipedExitedProcess({});
      };
      const mutedStream = {
        write: () => true,
      } as unknown as NodeJS.WriteStream;

      const exitCode = await runNodeCommand(tmp, {
        args: ["qa", "matrix"],
        spawn,
        stderr: mutedStream,
        stdout: mutedStream,
        runRuntimePostBuild: skipRuntimePostBuild,
      });

      expect(exitCode).toBe(0);
      const childArgs = spawnCalls.at(-1)?.args ?? [];
      expect(childArgs).toEqual(["openclaw.mjs", "qa", "matrix"]);
      expect(spawnCalls.at(-1)?.env.OPENCLAW_RUN_NODE_OUTPUT_LOG).toBeUndefined();
    });

    it("skips rebuilding when dist is current and the source tree is clean", async ({ tmp }) => {
      await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

      const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder();
      const exitCode = await runStatusCommand({
        tmp,
        spawn,
        spawnSync,
        runRuntimePostBuild: skipRuntimePostBuild,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([statusCommandSpawn()]);
    });

    it.for([undefined, "/explicit/checkout"])(
      "carries the checkout selector into the CLI (override: %s)",
      async (override, { tmp }) => {
        await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
        const { spawnSync } = createCurrentGitSpawnRecorder();
        let childEnv: NodeJS.ProcessEnv | undefined;
        const exitCode = await runNodeCommand(tmp, {
          env: { OPENCLAW_DEV_SOURCE_ROOT: override },
          spawn: (_cmd, _args, options) => {
            childEnv = options.env;
            return createExitedProcess(0);
          },
          spawnSync,
          runRuntimePostBuild: skipRuntimePostBuild,
        });
        expect(exitCode).toBe(0);
        expect(childEnv?.OPENCLAW_DEV_SOURCE_ROOT).toBe(override ?? tmp);
      },
    );

    it.for([
      { mode: "build", disable: undefined },
      { mode: "metadata", disable: "1" },
    ])(
      "carries private QA policy through $mode (disable: $disable)",
      async ({ mode, disable }, { tmp }) => {
        await setupStampedProject(tmp, {
          files: {
            [QA_LAB_PLUGIN_SDK_ENTRY]: "export const qaLab = true;\n",
            ...(mode === "metadata"
              ? { [QA_RUNTIME_PLUGIN_SDK_ENTRY]: "export const qaRuntime = true;\n" }
              : {}),
          },
          oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
        });
        const runRuntimePostBuild = vi.fn();
        const spawn = vi.fn((_cmd: string, _args: string[], _options: SpawnOptions) =>
          createExitedProcess(0),
        );
        const { spawnSync } = createCurrentGitSpawnRecorder();
        const exitCode = await runNodeCommand(tmp, {
          args: ["qa", "suite"],
          spawn,
          spawnSync,
          runRuntimePostBuild,
          env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: disable },
        });
        expect(exitCode).toBe(0);
        expect(spawn.mock.calls.map(([, args]) => args)).toEqual([
          ...(mode === "build" ? [expectedBuildSpawn().slice(1)] : []),
          ["openclaw.mjs", "qa", "suite"],
        ]);
        const expectedEnv = {
          OPENCLAW_BUILD_PRIVATE_QA: "1",
          OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: disable ?? "0",
        };
        for (const call of spawn.mock.calls) {
          expect(call[2].env).toMatchObject(expectedEnv);
        }
        if (mode === "metadata") {
          expect(runRuntimePostBuild).toHaveBeenCalledExactlyOnceWith({
            cwd: tmp,
            env: expect.objectContaining(expectedEnv),
          });
        } else {
          expect(runRuntimePostBuild).not.toHaveBeenCalled();
        }
      },
    );

    it("returns the canonical build failure without starting the CLI", async ({ tmp }) => {
      const spawn = vi.fn((cmd: string, args: string[] = []) => {
        if (cmd === process.execPath && isTsxScriptArgs(args, "scripts/build-all.mts")) {
          return createExitedProcess(23);
        }
        return createExitedProcess(0);
      });

      const exitCode = await runNodeCommand(tmp, { env: { OPENCLAW_FORCE_BUILD: "1" }, spawn });

      expect(exitCode).toBe(23);
      expect(spawn).toHaveBeenCalledOnce();
      expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
    });

    it("returns failure and releases the build lock when the canonical build spawn errors", async ({
      tmp,
    }) => {
      const spawn = vi.fn((cmd: string, args: string[] = []) => {
        if (cmd === process.execPath && isTsxScriptArgs(args, "scripts/build-all.mts")) {
          const events = new EventEmitter();
          queueMicrotask(() => events.emit("error", new Error("spawn failed")));
          return events;
        }
        return createExitedProcess(0);
      });

      const exitCode = await runNodeCommand(tmp, { env: { OPENCLAW_FORCE_BUILD: "1" }, spawn });

      expect(exitCode).toBe(1);
      expect(spawn).toHaveBeenCalledOnce();
      expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
    });

    it.for([
      { platform: "win32", signal: "SIGKILL", expected: 1 },
      { platform: "win32", signal: "SIGTERM", expected: 143 },
    ] as const)(
      "maps child signals to Windows exit codes: %j",
      async ({ platform, signal, expected }, { tmp }) => {
        await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });
        for (const rebuild of [false, true]) {
          const spawn = vi.fn(() => createExitedProcess(null, signal));
          const outcome = await runNodeCommand(tmp, {
            env: { OPENCLAW_FORCE_BUILD: rebuild ? "1" : "0" },
            platform,
            spawn,
            runRuntimePostBuild: skipRuntimePostBuild,
          });
          expect(outcome).toBe(expected);
          expect(spawn).toHaveBeenCalledOnce();
        }
      },
    );

    it.runIf(process.platform !== "win32").for([false, true])(
      "force-cleans the active child process group after SIGTERM (rebuild: %s)",
      async (rebuild, { tmp }) => {
        await setupStampedProject(tmp, { oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE] });

        const fakeProcess = Object.assign(createFakeProcess(), { stdin: { isTTY: false } });
        const child = Object.assign(new EventEmitter(), {
          pid: 42_420,
          kill: vi.fn(),
        });
        const groupSignals: Array<[number, string | number]> = [];
        const { promise: childSpawned, resolve: markChildSpawned } = createDeferred();
        const spawn = vi.fn((_cmd: string, _args: string[], _options: SpawnOptions) => {
          markChildSpawned();
          return child;
        });

        const exitCodePromise = runNodeCommand(tmp, {
          env: { OPENCLAW_FORCE_BUILD: rebuild ? "1" : "0" },
          platform: "darwin",
          process: fakeProcess,
          signalProcess: (pid: number, signal?: string | number) => {
            groupSignals.push([pid, signal ?? "SIGTERM"]);
            if (signal === "SIGTERM") {
              queueMicrotask(() => child.emit("exit", 0, null));
            }
            return true;
          },
          spawn,
          runRuntimePostBuild: skipRuntimePostBuild,
        });

        await Promise.race([childSpawned, exitCodePromise]);
        expect(spawn).toHaveBeenCalled();
        fakeProcess.emit("SIGTERM");
        const exitCode = await exitCodePromise;

        expect(exitCode).toBe(143);
        const spawnCall = firstMockCall(spawn);
        expect(spawnCall?.[1]).toEqual(
          rebuild ? expectedBuildSpawn().slice(1) : ["openclaw.mjs", "status"],
        );
        expect(spawnCall?.[2]).toMatchObject({
          detached: true,
          stdio: rebuild ? ["inherit", "pipe", "pipe"] : "inherit",
        });
        expect(spawn).toHaveBeenCalledOnce();
        expect(fsSync.existsSync(path.join(tmp, ".artifacts", "run-node-build.lock"))).toBe(false);
        expect(groupSignals).toEqual([
          [-42_420, "SIGTERM"],
          [-42_420, "SIGKILL"],
        ]);
        expect(child.kill).not.toHaveBeenCalled();
        expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
        expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
      },
    );

    it("rebuilds when git HEAD changes even if source mtimes do not exceed the old build stamp", async ({
      tmp,
    }) => {
      await setupStampedProject(tmp, {
        files: {
          [QA_LAB_PLUGIN_SDK_ENTRY]: "export {};\n",
          [QA_RUNTIME_PLUGIN_SDK_ENTRY]: "export {};\n",
        },
        oldPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE],
      });

      const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
        gitHead: "def456\n",
      });
      const exitCode = await runQaCommand({
        tmp,
        spawn,
        spawnSync,
        runRuntimePostBuild: skipRuntimePostBuild,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        expectedBuildSpawn(),
        [
          process.execPath,
          "openclaw.mjs",
          "qa",
          "suite",
          "--transport",
          "qa-channel",
          "--provider-mode",
          "mock-openai",
        ],
      ]);
    });

    it.for([
      { filePath: "extensions/demo/src/café.ts", watched: true },
      { filePath: EXTENSION_README, watched: false },
      { filePath: "src/..ignored.test.ts", watched: false },
      ...(process.platform === "win32"
        ? []
        : [
            { filePath: "src/line\nname.ts", watched: true },
            { filePath: "src/ignored.test.ts ", watched: true },
          ]),
    ])(
      "reports watched source changes with real Git: $filePath",
      async ({ filePath, watched }, { tmp }) => {
        await setupStampedProject(tmp, {
          files: { [filePath]: "export const value = 1;\n" },
          trackConfig: true,
        });
        const { git, deps } = await trackProjectWithGit(tmp);
        expect(resolveBuildRequirement(deps)).toEqual({ shouldBuild: false, reason: "clean" });

        await fs.writeFile(resolvePath(tmp, filePath), "export const value = 2;\n");
        await touchProjectFiles(tmp, [filePath], NEW_TIME);
        for (const quotePath of ["true", "false"]) {
          git("config", "core.quotePath", quotePath);
          expect(resolveBuildRequirement(deps)).toEqual({
            shouldBuild: watched,
            reason: watched ? "dirty_watched_tree" : "clean",
          });
        }
        const { spawnSync } = createSpawnRecorder();
        expect(resolveBuildRequirement({ ...deps, spawnSync })).toEqual({
          shouldBuild: watched,
          reason: watched ? "source_mtime_newer" : "clean",
        });
      },
    );

    it.for([
      { source: "src/café.ts", target: "src/café.test.ts", watched: true },
      { source: "src/café.test.ts", target: "src/café.ts", watched: true },
    ])(
      "checks both rename sides with real Git: $source to $target",
      async ({ source, target, watched }, { tmp }) => {
        await setupStampedProject(tmp, { files: { [source]: "export {};\n" } });
        const { git, deps } = await trackProjectWithGit(tmp);
        git("config", "status.renames", "true");
        git("mv", "--", source, target);

        expect(resolveBuildRequirement(deps)).toEqual({
          shouldBuild: watched,
          reason: watched ? "dirty_watched_tree" : "clean",
        });
      },
    );

    const GATEWAY_SERVICE_ENV = {
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    } as const;

    // Inside the managed gateway, a STALE rebuild over an existing dist is the
    // build-suicide path and must be suppressed; FORCE_BUILD still wins.
    for (const testCase of [
      {
        name: "suppresses a dirty-tree rebuild inside the managed gateway service",
        env: GATEWAY_SERVICE_ENV,
        gitStatus: ` M ${ROOT_SRC}\n`,
        expected: { shouldBuild: false, reason: "auto_build_suppressed_in_service" },
      },
      {
        name: "lets OPENCLAW_FORCE_BUILD override the managed-service suppression",
        env: { ...GATEWAY_SERVICE_ENV, OPENCLAW_FORCE_BUILD: "1" },
        gitStatus: ` M ${ROOT_SRC}\n`,
        expected: { shouldBuild: true, reason: "force_build" },
      },
    ]) {
      it(testCase.name, async () => {
        await withTestDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
          await setupTrackedProject(tmp, {
            files: { [ROOT_SRC]: "export const value = 1;\n" },
            buildPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, DIST_ENTRY, BUILD_STAMP],
          });

          const requirement = resolveBuildRequirement(
            createBuildRequirementDeps(tmp, {
              gitHead: "abc123\n",
              gitStatus: testCase.gitStatus,
              env: testCase.env,
            }),
          );

          expect(requirement).toEqual(testCase.expected);
        });
      });
    }

    it("still builds a MISSING dist entry inside the managed gateway service", async () => {
      await withTestDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
        await setupTrackedProject(tmp, {
          files: { [ROOT_SRC]: "export const value = 1;\n" },
          buildPaths: [ROOT_SRC, ROOT_TSCONFIG, ROOT_PACKAGE, DIST_ENTRY, BUILD_STAMP],
        });
        // Dist is genuinely absent, not merely stale; suppression must not apply
        // here or a fresh/partial worktree would never self-heal.
        await fs.rm(resolvePath(tmp, DIST_ENTRY));

        const requirement = resolveBuildRequirement(
          createBuildRequirementDeps(tmp, {
            gitHead: "abc123\n",
            gitStatus: "",
            env: GATEWAY_SERVICE_ENV,
          }),
        );

        expect(requirement).toEqual({
          shouldBuild: true,
          reason: "missing_dist_entry",
        });
      });
    });

    it("suppresses a stale runtime-postbuild sync inside the managed gateway service", async () => {
      await withTestDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
        // Dirty runtime-postbuild input (the manifest) yields the STALE reason
        // dirty_runtime_postbuild_inputs, which is the suicide path inside the
        // gateway; the build requirement itself stays clean.
        await setupTrackedProject(tmp, {
          files: {
            [ROOT_SRC]: "export const value = 1;\n",
            [EXTENSION_INDEX]: "export default {};\n",
            [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
            [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n',
            [DIST_EXTENSION_INDEX]: "export default {};\n",
          },
          buildPaths: [
            ROOT_SRC,
            EXTENSION_INDEX,
            EXTENSION_MANIFEST,
            DIST_EXTENSION_INDEX,
            ROOT_TSCONFIG,
            ROOT_PACKAGE,
            DIST_ENTRY,
            BUILD_STAMP,
            RUNTIME_POSTBUILD_STAMP,
          ],
        });

        const requirement = resolveRuntimePostBuildRequirement(
          createBuildRequirementDeps(tmp, {
            gitHead: "abc123\n",
            gitStatus: ` M ${EXTENSION_MANIFEST}\n`,
            env: GATEWAY_SERVICE_ENV,
          }),
        );

        expect(requirement).toEqual({
          shouldSync: false,
          reason: "auto_build_suppressed_in_service",
        });
      });
    });

    it.each([
      { label: "gateway RPC", args: ["gateway", "call", "status", "--json"] },
      { label: "gateway status", args: ["gateway", "status", "--json"] },
      { label: "remote agent", args: ["agent", "--message", "hello"] },
      { label: "dashboard", args: ["dashboard", "--no-open", "--yes"] },
    ])("does not rebuild for $label calls against an existing dirty dist", async ({ args }) => {
      await withTestDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
        await setupStampedProject(tmp, {
          files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
          trackConfig: true,
        });

        const runRuntimePostBuild = vi.fn();
        const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
          gitStatus: ` M ${ROOT_SRC}\0`,
        });
        const exitCode = await runStatusCommand({
          tmp,
          args,
          spawn,
          spawnSync,
          runRuntimePostBuild,
        });

        expect(exitCode).toBe(0);
        expect(spawnCalls).toEqual([[process.execPath, "openclaw.mjs", ...args]]);
        expect(runRuntimePostBuild).not.toHaveBeenCalled();
      });
    });

    it("rechecks a dirty dashboard client after waiting for an active build", async ({ tmp }) => {
      await setupStampedProject(tmp, { trackConfig: true });
      await fs.rm(resolvePath(tmp, BUILD_STAMP));

      const lockProcess = Object.assign(createFakeProcess(), {
        kill: vi.fn(() => true),
      }) as unknown as NodeJS.Process;
      const releaseLock = await acquireRunNodeBuildLock({
        cwd: tmp,
        args: ["gateway"],
        env: { OPENCLAW_RUNNER_LOG: "0" },
        fs: fsSync,
        process: lockProcess,
        stderr: { write: () => true } as unknown as NodeJS.WriteStream,
      });
      const { promise: waitingForLock, resolve: markWaiting } = createDeferred();
      const stderr = {
        write: (chunk: string | Buffer) => {
          if (String(chunk).includes("Waiting for TypeScript/runtime artifact lock")) {
            markWaiting();
          }
          return true;
        },
      } as unknown as NodeJS.WriteStream;
      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
        gitStatus: ` M ${ROOT_SRC}\0`,
      });
      const clientRun = runNodeCommand(tmp, {
        args: ["dashboard", "--no-open", "--yes"],
        env: { OPENCLAW_RUNNER_LOG: "1", OPENCLAW_RUN_NODE_BUILD_LOCK_POLL_MS: "1" },
        spawn,
        spawnSync,
        process: lockProcess,
        stderr,
        runRuntimePostBuild,
      });

      await waitingForLock;
      for (const stamp of [BUILD_STAMP, RUNTIME_POSTBUILD_STAMP]) {
        await fs.writeFile(
          resolvePath(tmp, stamp),
          '{"head":"abc123","inputsClean":true}\n',
          "utf-8",
        );
      }
      releaseLock();

      await expect(clientRun).resolves.toBe(0);
      expect(spawnCalls).toEqual([
        [process.execPath, "openclaw.mjs", "dashboard", "--no-open", "--yes"],
      ]);
      expect(runRuntimePostBuild).not.toHaveBeenCalled();
    });

    it.for([false, true])(
      "keeps legacy client stamps subject to required output checks (missing: %s)",
      async (missing, { tmp }) => {
        await setupStampedProject(tmp, {
          files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123"}\n' },
          trackConfig: true,
        });
        if (missing) {
          await fs.rm(resolvePath(tmp, DIST_CHANNEL_CATALOG));
        }
        const runRuntimePostBuild = vi.fn();
        const { spawn, spawnSync } = createCurrentGitSpawnRecorder();
        expect(
          await runStatusCommand({
            tmp,
            args: ["dashboard", "--no-open"],
            spawn,
            spawnSync,
            runRuntimePostBuild,
          }),
        ).toBe(0);
        expect(runRuntimePostBuild).toHaveBeenCalledTimes(missing ? 1 : 0);
      },
    );

    it.for(["build", "runtime"] as const)(
      "refreshes dirty-built %s artifacts after restoring the same HEAD source",
      async (scope, { tmp }) => {
        await setupStampedProject(tmp, {
          files: { "scripts/runtime-postbuild.mts": "export {};\n" },
          trackConfig: true,
        });
        const { git, deps } = await trackProjectWithGit(tmp);
        const needsRefresh = () =>
          scope === "build"
            ? resolveBuildRequirement(deps).shouldBuild
            : resolveRuntimePostBuildRequirement(deps).shouldSync;
        expect(needsRefresh()).toBe(false);
        const input = scope === "build" ? ROOT_SRC : "scripts/runtime-postbuild.mts";
        const original = await fs.readFile(resolvePath(tmp, input), "utf8");
        await fs.writeFile(resolvePath(tmp, input), `${original}\n`);
        expect(git("status", "--porcelain", "--", input)).not.toBe("");
        const stamp = scope === "build" ? writeBuildStamp : writeRuntimePostBuildStamp;
        stamp({ cwd: tmp, spawnSync: realSpawnSync });
        await fs.writeFile(resolvePath(tmp, input), original);
        expect(git("status", "--porcelain", "--", input)).toBe("");

        expect(needsRefresh()).toBe(true);
      },
    );

    it("ignores newer tracked config mtimes when Git proves the checkout is clean", async ({
      tmp,
    }) => {
      await setupStampedProject(tmp, {
        files: { [ROOT_TSDOWN]: "export default {};\n" },
        oldPaths: [ROOT_SRC],
        newPaths: [ROOT_TSCONFIG, ROOT_PACKAGE, ROOT_TSDOWN],
      });

      const requirement = resolveBuildRequirement(createBuildRequirementDeps(tmp));

      expect(requirement).toEqual({
        shouldBuild: false,
        reason: "clean",
      });
    });

    it("uses newer config mtimes when Git state is unavailable", async ({ tmp }) => {
      await setupStampedProject(tmp, {
        oldPaths: [ROOT_SRC],
        newPaths: [ROOT_TSCONFIG, ROOT_PACKAGE],
      });
      const { spawnSync } = createSpawnRecorder();

      const requirement = resolveBuildRequirement({
        ...createBuildRequirementDeps(tmp),
        spawnSync,
      });

      expect(requirement).toEqual({
        shouldBuild: true,
        reason: "config_newer",
      });
    });

    it.for([
      { gitStatus: ` M ${EXTENSION_PACKAGE}\0`, reason: "dirty_watched_tree" },
      { gitStatus: "", reason: "missing_bundled_plugin_dist_entry" },
    ])(
      "rebuilds partially missing plugin outputs: $reason",
      async ({ gitStatus, reason }, { tmp }) => {
        await setupStampedProject(tmp, {
          files: {
            [EXTENSION_SRC]: "export default {};\n",
            [EXTENSION_EXTRA_SRC]: "export const extra = true;\n",
            [EXTENSION_MANIFEST]: '{"id":"demo","configSchema":{"type":"object"}}\n',
            [EXTENSION_PACKAGE]:
              '{"openclaw":{"extensions":["./src/index.ts","./src/extra.ts"]}}\n',
            [DIST_EXTENSION_SRC]: "export default {};\n",
          },
          trackConfig: true,
        });
        expect(resolveBuildRequirement(createBuildRequirementDeps(tmp, { gitStatus }))).toEqual({
          shouldBuild: true,
          reason,
        });
      },
    );

    describe("acquireRunNodeBuildLock", () => {
      const lockDeps = (tmp: string, fakeProcess: NodeJS.Process) => ({
        cwd: tmp,
        args: ["status"],
        env: { OPENCLAW_RUNNER_LOG: "0" },
        fs: fsSync,
        process: fakeProcess,
        stderr: { write: () => true } as unknown as NodeJS.WriteStream,
      });

      it("releases the lock directory on process exit", async ({ tmp }) => {
        const fakeProcess = createFakeProcess();
        const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");

        const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
        expect(fsSync.existsSync(lockDir)).toBe(true);

        fakeProcess.emit("exit");
        expect(fsSync.existsSync(lockDir)).toBe(false);
        expect(release()).toBeUndefined();
      });

      it("wakes a contended lock wait when cancellation arrives", async ({ tmp }) => {
        const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");
        await fs.mkdir(lockDir, { recursive: true });
        await fs.writeFile(
          path.join(lockDir, "owner.json"),
          JSON.stringify({ pid: process.pid, args: ["gateway"] }),
          "utf-8",
        );
        const controller = new AbortController();
        const waiting = acquireRunNodeBuildLock(
          {
            ...lockDeps(tmp, createFakeProcess()),
            env: { OPENCLAW_RUNNER_LOG: "0", OPENCLAW_RUN_NODE_BUILD_LOCK_POLL_MS: "600000" },
          },
          controller.signal,
        );
        controller.abort();

        await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
        expect(fsSync.existsSync(lockDir)).toBe(true);
      });

      it("removes a lock left by a dead wrapper process without waiting for age-out", async ({
        tmp,
      }) => {
        const lockDir = path.join(tmp, ".artifacts", "run-node-build.lock");
        await fs.mkdir(lockDir, { recursive: true });
        await fs.writeFile(
          path.join(lockDir, "owner.json"),
          JSON.stringify({ pid: 987654, args: ["gateway"] }),
          "utf-8",
        );

        const fakeProcess = Object.assign(createFakeProcess(), {
          kill: vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
            if (pid === 987654 && signal === 0) {
              const err = new Error("missing process") as Error & { code: string };
              err.code = "ESRCH";
              throw err;
            }
            return true;
          }),
        }) as unknown as NodeJS.Process;

        const release = await acquireRunNodeBuildLock(lockDeps(tmp, fakeProcess));
        expect(fakeProcess["kill"]).toHaveBeenCalledWith(987654, 0);
        expect(JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf-8")).pid).toBe(
          4242,
        );

        release();
        expect(fsSync.existsSync(lockDir)).toBe(false);
      });
    });
  });
});
