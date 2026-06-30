import { describe, expect, it } from "vitest";
import { parseClaudeStreamLine, runClaudeTurn } from "./run-turn.js";

const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: "s1" });
const ASSISTANT = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "Working" }] },
});
const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  result: "Done",
  is_error: false,
  session_id: "s1",
});

// Spawn a fake `claude` (node -e) so the subprocess lifecycle is exercised
// end-to-end without the real CLI.
function fakeTurn(script: string, idleTimeoutMs = 5_000, signal?: AbortSignal) {
  return runClaudeTurn({
    binary: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    prompt: "hi",
    idleTimeoutMs,
    ...(signal ? { signal } : {}),
  });
}

describe("parseClaudeStreamLine", () => {
  it("captures the session id from the init event", () => {
    const events = parseClaudeStreamLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1", cwd: "/repo" }),
    );
    expect(events).toEqual([{ kind: "session", sessionId: "sess-1" }]);
  });

  it("extracts text and tool_use blocks from assistant events", () => {
    const events = parseClaudeStreamLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Looking into it" },
            { type: "tool_use", name: "Read", input: {} },
            { type: "text", text: "   " },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { kind: "assistant", text: "Looking into it" },
      { kind: "tool", name: "Read" },
    ]);
  });

  it("marks a successful result and its session id", () => {
    const events = parseClaudeStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Done.",
        is_error: false,
        session_id: "sess-2",
      }),
    );
    expect(events).toEqual([
      { kind: "result", text: "Done.", isError: false, sessionId: "sess-2" },
    ]);
  });

  it("flags non-success result subtypes as errors", () => {
    const [event] = parseClaudeStreamLine(
      JSON.stringify({ type: "result", subtype: "error_max_turns", result: "" }),
    );
    expect(event).toMatchObject({ kind: "result", isError: true });
  });

  it("ignores blank lines, malformed JSON, and unknown event types", () => {
    expect(parseClaudeStreamLine("")).toEqual([]);
    expect(parseClaudeStreamLine("   ")).toEqual([]);
    expect(parseClaudeStreamLine("{not json")).toEqual([]);
    expect(parseClaudeStreamLine(JSON.stringify({ type: "stream_event", foo: 1 }))).toEqual([]);
  });
});

describe("runClaudeTurn (subprocess)", () => {
  it("resolves a successful turn with the final result and session id", async () => {
    const script = `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(`${INIT}\n${ASSISTANT}\n${RESULT}\n`)});process.exit(0);});`;
    const turn = await fakeTurn(script);
    expect(turn).toMatchObject({ sessionId: "s1", finalText: "Done", isError: false });
  });

  it("flags a crashed turn (partial text, non-zero exit, no result) as an error", async () => {
    const script = `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(`${INIT}\n${ASSISTANT}\n`)});process.exit(1);});`;
    const turn = await fakeTurn(script);
    expect(turn).toMatchObject({ finalText: "Working", isError: true });
  });

  it("resolves on the result event even if the process lingers (no idle reject)", async () => {
    const script = `let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(`${INIT}\n${RESULT}\n`)});setInterval(()=>{},1000);});`;
    const turn = await fakeTurn(script, 200);
    expect(turn).toMatchObject({ finalText: "Done", isError: false });
  });

  it("rejects (without crashing) when the CLI exits before reading stdin", async () => {
    await expect(fakeTurn("process.exit(1);")).rejects.toThrow(/exited/);
  });

  it("aborts an in-flight turn via the signal", async () => {
    const controller = new AbortController();
    const script = `process.stdin.on('end',()=>{});setInterval(()=>{},1000);`;
    const promise = fakeTurn(script, 0, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toThrow(/aborted/);
  });
});
