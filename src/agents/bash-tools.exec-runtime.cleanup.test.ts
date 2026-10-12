import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ManagedRun, RunExit, SpawnInput } from "../process/supervisor/types.js";
import { readBackgroundProcesses } from "./bash-process-observation.js";
import {
  acknowledgeNotifyOnExit,
  getActiveBackgroundExecSessionCount,
  getFinishedSession,
  markBackgrounded,
  waitForExecScope,
} from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";

const supervisorMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisorMock,
}));

beforeEach(() => {
  resetProcessRegistryForTests();
  supervisorMock.spawn.mockReset();
});
afterEach(() => {
  resetProcessRegistryForTests();
});

it.each([
  { fails: false, beforeJoin: false, commandCode: 0 },
  { fails: true, beforeJoin: false, commandCode: 0 },
  { fails: true, beforeJoin: true, commandCode: 0 },
  { fails: true, beforeJoin: false, commandCode: 127 },
])(
  "joins sandbox artifacts and retains cleanup failure (fails=$fails, beforeJoin=$beforeJoin, commandCode=$commandCode)",
  async ({ fails, beforeJoin, commandCode }) => {
    const finalization = createDeferred();
    const entered = createDeferred();
    const cleanupScope = createAgentCleanupScope();
    const scopeKey = "scope:sandbox-artifact-cleanup";
    supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput): Promise<ManagedRun> => ({
      activity: { resultSettled: true, lastOutputAtMs: Date.now() },
      runId: input.runId ?? "test-run",
      pid: 1234,
      startedAtMs: Date.now(),
      stdin: { write: vi.fn(), end: vi.fn(), destroy: vi.fn() },
      cancel: vi.fn(),
      wait: async () => ({
        reason: "exit",
        exitCode: commandCode,
        exitSignal: null,
        durationMs: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    }));
    let run: Awaited<ReturnType<typeof runExecProcess>> | undefined;
    const finalizeExec = vi.fn(async () => {
      entered.resolve();
      await finalization.promise;
      if (fails) {
        throw new Error("sandbox artifact cleanup failed");
      }
    });
    try {
      await cleanupScope.run(async () => {
        run = await runExecProcess({
          command: "sandbox-fixture",
          workdir: "/tmp",
          env: {},
          scopeKey,
          sandbox: {
            containerName: "fixture",
            workspaceDir: "/workspace",
            containerWorkdir: "/workspace",
            buildExecSpec: async () => ({
              argv: ["sandbox-fixture"],
              env: {},
              stdinMode: "pipe-closed",
            }),
            finalizeExec,
          },
          usePty: false,
          warnings: [],
          maxOutput: 1000,
          pendingMaxOutput: 1000,
          notifyOnExit: false,
          timeoutSec: null,
        });
        markBackgrounded(run.session);
        await entered.promise;
        if (beforeJoin) {
          finalization.resolve();
          await run.promise;
        }
        let joined = false;
        const join = waitForExecScope(scopeKey).then(() => {
          joined = true;
        });
        if (!beforeJoin) {
          await Promise.resolve();
          expect(joined).toBe(false);
          expect(run.session.finalizing).toBe(true);
          finalization.resolve();
        }
        await join;
        const outcome = await run.promise;
        expect(outcome.status).toBe(fails || commandCode !== 0 ? "failed" : "completed");
        expect(finalizeExec).toHaveBeenCalledOnce();
      });
      expect(cleanupScope.outcome).toBe(fails ? "uncertain" : "closed");
    } finally {
      finalization.resolve();
      await run?.promise;
    }
  },
);

describe("terminal execution-context release", () => {
  it.each([
    { path: "notify", trace: ["task", "enqueue"] },
    { path: "quiet", trace: ["task"] },
    { path: "unrouted", trace: ["task"] },
    { path: "observed", trace: ["task"] },
  ])(
    "releases routing after $path without changing notification order",
    async ({ path, trace }) => {
      const exit = createDeferred<RunExit>();
      const observed: string[] = [];
      const removal = vi.fn(() => true);
      const deliveryContext = { channel: "telegram", to: "synthetic-chat" };
      enqueueSessionEventMock.mockImplementation((_text, options) => {
        observed.push("enqueue");
        expect(options.deliveryContext).toEqual(deliveryContext);
        return {
          id: "exec-event",
          cancel: removal,
          settled: Promise.resolve({
            status: "completed",
            executionStarted: true,
            delivered: false,
          }),
        };
      });
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
        ...runtimeManagedRun(input, path === "quiet" ? "" : "retained output\n"),
        wait: () => exit.promise,
      }));
      const run = await runTestExecProcess({
        command: "context-release",
        scopeKey: "global",
        sessionKey: path === "unrouted" ? undefined : "agent:main:main",
        agentId: "main",
        eventRouting: { mainKey: "main", sessionScope: "per-sender" },
        notifyDeliveryContext: deliveryContext,
        notifyOnExit: true,
        notifyOnExitEmptySuccess: false,
        onSettledBeforeNotify: () => {
          observed.push("task");
        },
      });
      markBackgrounded(run.session);
      const scope = { scopeKeys: ["global"], agentId: "main" };
      const running = readBackgroundProcesses(scope).processes[0];
      expect(running).toMatchObject({ processId: run.session.id, status: "running" });
      if (path === "observed") {
        acknowledgeNotifyOnExit(run.session);
      }
      exit.resolve(createRunExit());
      const outcome = await run.promise;
      expect(observed).toEqual(trace);
      expect(outcome.status).toBe("completed");
      const retained = getFinishedSession(run.session.id);
      expect(retained).toMatchObject({ scopeKey: "global", terminalStatus: "completed" });
      expect(readBackgroundProcesses(scope).processes).toEqual([
        expect.objectContaining({
          processId: run.session.id,
          instanceId: running?.instanceId,
          status: "completed",
          canStop: false,
        }),
      ]);
      expect(readBackgroundProcesses({ ...scope, agentId: "other" }).processes).toEqual([]);
      for (const field of [
        "sessionKey",
        "eventRouting",
        "notifyDeliveryContext",
        "notifySessionTarget",
        "notifyOnExit",
        "notifyOnExitEmptySuccess",
        "stdin",
      ] as const) {
        expect(retained?.[field], field).toBeUndefined();
      }
      expect(retained?.notifyOnExitRemoval).toBe(trace.includes("enqueue") ? removal : undefined);
      expect(removal).not.toHaveBeenCalled();
    },
  );
});

describe("exec settlement recovery", () => {
  it.each([
    { boundary: "task", asynchronous: true },
    { boundary: "persistent task", asynchronous: true },
    { boundary: "stdin", asynchronous: true },
  ])(
    "settles $boundary failure with asynchronous=$asynchronous before releasing the exec scope",
    async ({ boundary, asynchronous }) => {
      const exit = createDeferred<RunExit>();
      const settlementStarted = createDeferred();
      const settlement = createDeferred();
      const correctionStarted = createDeferred();
      const correction = createDeferred();
      const observed: string[] = [];
      const identities: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
      const scopeKey = `settlement-recovery:${boundary}:${asynchronous}`;
      const failure = new Error("process settlement failed");
      enqueueSessionEventMock.mockImplementation(() => {
        observed.push("enqueue");
        if (boundary === "enqueue") {
          throw failure;
        }
        return {
          id: "exec-event",
          cancel: vi.fn(() => true),
          settled: Promise.resolve({
            status: "completed",
            executionStarted: true,
            delivered: false,
          }),
        };
      });
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
        ...runtimeManagedRun(input, "process output\n"),
        wait: () => exit.promise,
      }));
      const run = await withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:settlement-recovery" },
        () =>
          runTestExecProcess({
            command: "settlement-recovery",
            scopeKey,
            sessionKey: "agent:main:settlement-recovery",
            agentId: "main",
            eventRouting: { mainKey: "main", sessionScope: "per-sender" },
            notifyDeliveryContext: { channel: "telegram", to: "synthetic-chat" },
            notifyOnExit: true,
            notifyOnExitEmptySuccess: false,
            onSettledBeforeNotify: (outcome) => {
              observed.push(`task:${outcome.status}`);
              identities.push(getGatewayToolCallerIdentity());
              if (!asynchronous) {
                if (
                  boundary === "persistent task" ||
                  (boundary === "task" && observed.length === 1)
                ) {
                  throw failure;
                }
                return undefined;
              }
              if (outcome.status === "failed") {
                correctionStarted.resolve();
                return correction.promise.then(() => {
                  if (boundary === "persistent task") {
                    throw failure;
                  }
                });
              }
              settlementStarted.resolve();
              const pending = settlement.promise.then(() => {
                if (boundary === "task" || boundary === "persistent task") {
                  throw failure;
                }
              });
              void pending.catch(() => {});
              return pending;
            },
          }),
      );
      if (boundary === "stdin") {
        run.session.stdin = {
          write: vi.fn(),
          end: vi.fn(),
          destroy() {
            observed.push("stdin");
            throw failure;
          },
        };
      }
      markBackgrounded(run.session);
      const joined = waitForExecScope(scopeKey).then(() => observed.push("scope-released"));
      exit.resolve(createRunExit());
      try {
        if (asynchronous) {
          await settlementStarted.promise;
          expect(run.session.finalizing).toBe(true);
          expect(run.session.exited).toBe(false);
          expect(getActiveBackgroundExecSessionCount()).toBe(1);
          expect(observed).toEqual(["task:completed"]);
          settlement.resolve();
          await correctionStarted.promise;
          expect(run.session.finalizing).toBe(true);
          expect(getActiveBackgroundExecSessionCount()).toBe(1);
          expect(observed).not.toContain("scope-released");
          correction.resolve();
        }
        if (boundary === "persistent task") {
          await expect(run.promise).rejects.toBe(failure);
        } else {
          await expect(run.promise).resolves.toMatchObject({
            status: boundary === "enqueue" ? "completed" : "failed",
          });
        }
        await joined;
        expect(observed).toEqual([
          "task:completed",
          ...(boundary === "stdin" ? ["stdin"] : []),
          ...(boundary === "enqueue" ? ["enqueue"] : ["task:failed"]),
          "scope-released",
        ]);
        expect(identities).toEqual(boundary === "enqueue" ? [undefined] : [undefined, undefined]);
        expect(getActiveBackgroundExecSessionCount()).toBe(0);
        expect(run.session.finalizing).toBe(false);
        expect(run.session.terminalStatus).toBe("completed");
        if (boundary !== "stdin") {
          expect(getFinishedSession(run.session.id)).toMatchObject({
            terminalStatus: "completed",
            aggregated: "process output\n",
          });
        }
        for (const field of [
          "sessionKey",
          "eventRouting",
          "notifyDeliveryContext",
          "notifySessionTarget",
          "notifyOnExit",
          "notifyOnExitEmptySuccess",
        ] as const) {
          expect(run.session[field], field).toBeUndefined();
        }
      } finally {
        settlement.resolve();
        correction.resolve();
        await Promise.allSettled([run.promise, joined]);
      }
    },
  );
});
