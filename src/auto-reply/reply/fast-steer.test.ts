import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const runtime = vi.hoisted(() => ({
  resolveActiveEmbeddedRunHandleSessionId: vi.fn<(sessionKey: string) => string | undefined>(),
  isEmbeddedAgentRunHandleActive: vi.fn<(sessionId: string) => boolean>(),
  queueEmbeddedAgentMessageWithOutcomeAsync:
    vi.fn<(sessionId: string, text: string, options?: unknown) => Promise<{ queued: boolean }>>(),
}));
const queue = vi.hoisted(() => ({
  resolveQueueSettings: vi.fn<() => { mode: string }>(),
}));

vi.mock("./commands-steer.runtime.js", () => runtime);
vi.mock("./queue/settings-runtime.js", () => queue);

import { tryFastSteerActiveFollowup } from "./fast-steer.js";

const cfg = {} as OpenClawConfig;
const base = { sessionKey: "agent:main:s1", cfg, channel: "webchat", sessionEntry: undefined };

beforeEach(() => {
  vi.clearAllMocks();
  runtime.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue("sid-1");
  runtime.isEmbeddedAgentRunHandleActive.mockReturnValue(true);
  runtime.queueEmbeddedAgentMessageWithOutcomeAsync.mockResolvedValue({ queued: true });
  queue.resolveQueueSettings.mockReturnValue({ mode: "steer" });
});

describe("tryFastSteerActiveFollowup", () => {
  it("injects a steer into the active run and reports success", async () => {
    const ok = await tryFastSteerActiveFollowup({ ...base, rawText: "forget that, do X" });
    expect(ok).toBe(true);
    expect(runtime.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "sid-1",
      "forget that, do X",
      expect.objectContaining({ steeringMode: "all" }),
    );
  });

  it("returns false (no inject) when there is no active run", async () => {
    runtime.resolveActiveEmbeddedRunHandleSessionId.mockReturnValue(undefined);
    const ok = await tryFastSteerActiveFollowup({ ...base, rawText: "hi" });
    expect(ok).toBe(false);
    expect(runtime.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("returns false when the resolved run id is no longer active", async () => {
    runtime.isEmbeddedAgentRunHandleActive.mockReturnValue(false);
    const ok = await tryFastSteerActiveFollowup({ ...base, rawText: "hi" });
    expect(ok).toBe(false);
    expect(runtime.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("falls back (false) when the injection is rejected / not committed", async () => {
    runtime.queueEmbeddedAgentMessageWithOutcomeAsync.mockResolvedValue({ queued: false });
    const ok = await tryFastSteerActiveFollowup({ ...base, rawText: "hi" });
    expect(ok).toBe(false);
  });

  it("falls back (false) when the injection throws", async () => {
    runtime.queueEmbeddedAgentMessageWithOutcomeAsync.mockRejectedValue(new Error("boom"));
    const ok = await tryFastSteerActiveFollowup({ ...base, rawText: "hi" });
    expect(ok).toBe(false);
  });

  it("defers to the normal path when the configured mode is not steer", async () => {
    queue.resolveQueueSettings.mockReturnValue({ mode: "followup" });
    const ok = await tryFastSteerActiveFollowup({ ...base, rawText: "hi" });
    expect(ok).toBe(false);
    expect(runtime.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("defers to the normal path when an inline queue directive is present", async () => {
    const ok = await tryFastSteerActiveFollowup({ ...base, rawText: "do X /queue followup" });
    expect(ok).toBe(false);
    expect(runtime.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("returns false for empty text", async () => {
    const ok = await tryFastSteerActiveFollowup({ ...base, rawText: "   " });
    expect(ok).toBe(false);
  });

  it("strips inline (non-queue) directives from the steered text", async () => {
    await tryFastSteerActiveFollowup({ ...base, rawText: "/think high actually do Y" });
    expect(runtime.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "sid-1",
      "actually do Y",
      expect.anything(),
    );
  });
});
