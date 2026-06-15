import { appendFileSync } from "node:fs";
// Reproduces the steer/follow-up takeover: when one embedded attempt persists a
// user message (e.g. a drained steering message) while a SIBLING attempt over the
// same session file has released its prompt lock, the sibling's takeover fence
// must not mistake that legitimate in-process write for a hostile external one.
//
// A genuinely foreign write (no in-process controller claimed it) must still trip
// the fence — that boundary is the whole point of the takeover detector, so the
// fix may not blanket-trust any append.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEmbeddedAttemptSessionLockController,
  EmbeddedAttemptSessionTakeoverError,
  type EmbeddedAttemptSessionLockController,
} from "./attempt.session-lock.js";

type FakeLock = { release: () => Promise<void> };

// Minimal in-process mutex per session file: mirrors acquireSessionWriteLock's
// exclusivity (one holder at a time, FIFO) without touching the real lock files.
function makeAcquireSessionWriteLock() {
  const chains = new Map<string, Promise<unknown>>();
  return async (params: { sessionFile: string }): Promise<FakeLock> => {
    const key = params.sessionFile;
    const prior = chains.get(key) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    chains.set(
      key,
      prior.then(() => gate),
    );
    await prior;
    return {
      release: async () => {
        releaseGate();
      },
    };
  };
}

const ASSISTANT_LINE = `${JSON.stringify({ message: { role: "assistant", content: "ok" } })}\n`;
const USER_STEER_LINE = `${JSON.stringify({ message: { role: "user", content: "643" } })}\n`;

describe("embedded attempt session-lock steer fence", () => {
  let dir: string;
  let sessionFile: string;
  const controllers: EmbeddedAttemptSessionLockController[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "oc-steer-fence-"));
    sessionFile = path.join(dir, "session.jsonl");
    await writeFile(sessionFile, ASSISTANT_LINE, "utf8");
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) {
      await controller.dispose().catch(() => {});
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function createController(): Promise<EmbeddedAttemptSessionLockController> {
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: makeAcquireSessionWriteLock() as never,
      lockOptions: { sessionFile, timeoutMs: 1000, staleMs: 1000, maxHoldMs: 1000 },
    });
    controllers.push(controller);
    return controller;
  }

  it("does not trip a sibling's takeover fence when an in-process attempt persists a steered user message", async () => {
    // Victim lane (e.g. the exec/process poll) holds then releases its prompt lock.
    const victim = await createController();
    await victim.releaseForPrompt();

    // Steer lane: a second attempt over the same file releases for prompt, then its
    // session manager persists the drained steering message (a user line) and reports
    // it via the same onMessagePersisted -> refreshAfterOwnedSessionWrite hook.
    const steerLane = await createController();
    await steerLane.releaseForPrompt();
    appendFileSync(sessionFile, USER_STEER_LINE);
    steerLane.refreshAfterOwnedSessionWrite();

    // The victim reacquiring after its own prompt must accept the sibling write.
    await expect(victim.reacquireAfterPrompt()).resolves.toBeUndefined();
    expect(victim.hasSessionTakeover()).toBe(false);
  });

  it("does not trip the takeover fence when the canonical session file is created during a released prompt (lazy first commit)", async () => {
    // Production repro (single controller, not siblings): the canonical session
    // .jsonl is written lazily — a long single turn streams to the trajectory and
    // has not committed to the canonical file when the prompt lock releases, so the
    // fence arms on a NON-EXISTENT file. The first canonical write (here the drained
    // steer's user line) CREATES the file. That creation is this attempt's own first
    // commit; the fence must not read an absent->exists transition as a takeover.
    const absentFile = path.join(dir, "lazy-session.jsonl");
    const controller = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock: makeAcquireSessionWriteLock() as never,
      lockOptions: { sessionFile: absentFile, timeoutMs: 1000, staleMs: 1000, maxHoldMs: 1000 },
    });
    controllers.push(controller);

    await controller.releaseForPrompt(); // arms the fence while absentFile does not exist
    appendFileSync(absentFile, USER_STEER_LINE); // first canonical write creates the file

    await expect(controller.reacquireAfterPrompt()).resolves.toBeUndefined();
    expect(controller.hasSessionTakeover()).toBe(false);
  });

  it("still trips the takeover fence for a foreign write that no in-process attempt claimed", async () => {
    const victim = await createController();
    await victim.releaseForPrompt();

    // No controller persists/claims this append — it stands in for a hostile or
    // external writer. The fence must still reject it.
    appendFileSync(sessionFile, USER_STEER_LINE);

    await expect(victim.reacquireAfterPrompt()).rejects.toBeInstanceOf(
      EmbeddedAttemptSessionTakeoverError,
    );
  });
});
