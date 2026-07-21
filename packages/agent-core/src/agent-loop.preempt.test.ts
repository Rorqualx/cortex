// Covers cooperative steering-preemption of in-flight tool batches.
import { describe, expect, it } from "vitest";
import { agentLoop } from "./agent-loop.js";
import { Agent } from "./agent.js";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "./llm.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "./types.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
) {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  } satisfies AssistantMessage;
}

// Minimal stream that yields exactly one scripted assistant message per turn.
function scriptedStreamFn(messages: AssistantMessage[]): StreamFn {
  let turn = 0;
  return () => {
    const message = messages[Math.min(turn, messages.length - 1)];
    if (!message) {
      throw new Error("scriptedStreamFn: no scripted message for turn");
    }
    turn += 1;
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "done" as const,
          reason: message.content.some((c) => c.type === "toolCall")
            ? ("toolUse" as const)
            : ("stop" as const),
          message,
        };
      },
      result: async () => message,
    };
  };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function toolResultMessages(result: AgentMessage[]): ToolResultMessage[] {
  return result.filter((m): m is ToolResultMessage => m.role === "toolResult");
}

function preemptConfig(params: { tool: AgentTool; steerText: string }): {
  config: AgentLoopConfig;
  context: AgentContext;
} {
  let steerDelivered = false;
  const config: AgentLoopConfig = {
    model,
    convertToLlm: (messages) => messages as Message[],
    // A steer is already pending when the batch begins: return a pre-aborted
    // signal so the in-flight preemptable tool is cut immediately.
    beginToolBatchPreempt: () => AbortSignal.abort(),
    getSteeringMessages: async () => {
      if (steerDelivered) {
        return [];
      }
      steerDelivered = true;
      return [{ role: "user", content: params.steerText, timestamp: 2 }];
    },
  };
  const context: AgentContext = { systemPrompt: "", messages: [], tools: [params.tool] };
  return { config, context };
}

describe("agentLoop steering preemption", () => {
  it("interrupts an in-flight preemptable tool and injects the steer", async () => {
    let resolved = false;
    const hangTool: AgentTool = {
      name: "hang",
      label: "Hang",
      description: "Never resolves until the process exits.",
      parameters: { type: "object", properties: {} },
      preemptable: true,
      execute: () =>
        new Promise(() => {
          // Intentionally never resolves; preemption must finalize it.
        }).then(() => {
          resolved = true;
          return { content: [{ type: "text", text: "should not happen" }], details: {} };
        }),
    } as unknown as AgentTool;

    const { config, context } = preemptConfig({ tool: hangTool, steerText: "actually stop" });
    const stream = agentLoop(
      [{ role: "user", content: "run hang", timestamp: 1 }],
      context,
      config,
      undefined,
      scriptedStreamFn([
        assistant([{ type: "toolCall", id: "t1", name: "hang", arguments: {} }], "toolUse"),
        assistant([{ type: "text", text: "ok, stopped" }], "stop"),
      ]),
    );

    await collect(stream);
    const result = await stream.result();

    const toolResults = toolResultMessages(result);
    expect(toolResults).toHaveLength(1);
    expect(JSON.stringify(toolResults[0]?.content)).toContain(
      "interrupted to handle a new user message",
    );
    // The steer was injected as a user message after the interrupted tool result.
    const injectedSteer = result.find(
      (m) => m.role === "user" && JSON.stringify(m.content ?? "").includes("actually stop"),
    );
    expect(injectedSteer).toBeDefined();
    expect(resolved).toBe(false);
  });

  it("does not interrupt a non-preemptable tool", async () => {
    const editTool: AgentTool = {
      name: "edit",
      label: "Edit",
      description: "Completes its write before returning.",
      parameters: { type: "object", properties: {} },
      preemptable: false,
      execute: async () => ({ content: [{ type: "text", text: "edit applied" }], details: {} }),
    } as unknown as AgentTool;

    const { config, context } = preemptConfig({ tool: editTool, steerText: "wait" });
    const stream = agentLoop(
      [{ role: "user", content: "run edit", timestamp: 1 }],
      context,
      config,
      undefined,
      scriptedStreamFn([
        assistant([{ type: "toolCall", id: "t1", name: "edit", arguments: {} }], "toolUse"),
        assistant([{ type: "text", text: "done" }], "stop"),
      ]),
    );

    await collect(stream);
    const result = await stream.result();

    const toolResults = toolResultMessages(result);
    expect(toolResults).toHaveLength(1);
    expect(JSON.stringify(toolResults[0]?.content)).toContain("edit applied");
    expect(JSON.stringify(toolResults[0]?.content)).not.toContain("interrupted");
  });
});

describe("Agent steering preemption wiring", () => {
  it("steer() cuts the in-flight preemptable batch when preemptOnSteer is set", async () => {
    let signalToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      signalToolStarted = resolve;
    });
    const hangTool: AgentTool = {
      name: "hang",
      label: "Hang",
      description: "Signals it started, then never settles.",
      parameters: { type: "object", properties: {} },
      preemptable: true,
      // Never settles and ignores the signal, so the race is resolved
      // deterministically by the preempt rather than the tool's own result.
      execute: () =>
        new Promise<never>(() => {
          signalToolStarted();
        }),
    } as unknown as AgentTool;

    const agent = new Agent({
      initialState: { systemPrompt: "", model, thinkingLevel: "off", tools: [hangTool] },
      convertToLlm: (messages) => messages as Message[],
      streamFn: scriptedStreamFn([
        assistant([{ type: "toolCall", id: "t1", name: "hang", arguments: {} }], "toolUse"),
        assistant([{ type: "text", text: "ok, stopped" }], "stop"),
      ]),
      preemptOnSteer: true,
    });

    const runPromise = agent.prompt("run hang");
    await toolStarted;
    agent.steer({ role: "user", content: "stop now", timestamp: 2 });
    await runPromise;

    const messages = agent.state.messages;
    const toolResults = messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    expect(JSON.stringify(toolResults[0]?.content)).toContain(
      "interrupted to handle a new user message",
    );
    const injectedSteer = messages.find(
      (m) => m.role === "user" && JSON.stringify(m.content ?? "").includes("stop now"),
    );
    expect(injectedSteer).toBeDefined();
  });

  it("does not preempt when preemptOnSteer is unset (steer waits for the batch)", async () => {
    let signalToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      signalToolStarted = resolve;
    });
    let aborted = false;
    const slowTool: AgentTool = {
      name: "slow",
      label: "Slow",
      description: "Resolves shortly after starting; honors abort for assertion.",
      parameters: { type: "object", properties: {} },
      preemptable: true,
      execute: (_id: string, _params: unknown, signal?: AbortSignal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
          });
          signalToolStarted();
          setTimeout(
            () => resolve({ content: [{ type: "text", text: "slow done" }], details: {} }),
            10,
          );
        }),
    } as unknown as AgentTool;

    const agent = new Agent({
      initialState: { systemPrompt: "", model, thinkingLevel: "off", tools: [slowTool] },
      convertToLlm: (messages) => messages as Message[],
      streamFn: scriptedStreamFn([
        assistant([{ type: "toolCall", id: "t1", name: "slow", arguments: {} }], "toolUse"),
        assistant([{ type: "text", text: "done" }], "stop"),
      ]),
      // preemptOnSteer omitted -> defaults false.
    });

    const runPromise = agent.prompt("run slow");
    await toolStarted;
    agent.steer({ role: "user", content: "later", timestamp: 2 });
    await runPromise;

    const toolResults = agent.state.messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    expect(JSON.stringify(toolResults[0]?.content)).toContain("slow done");
    expect(aborted).toBe(false);
  });

  it("preempts the batch when a steer arrived during the turn's streaming", async () => {
    let agentRef: Agent | undefined;
    const hangTool: AgentTool = {
      name: "hang",
      label: "Hang",
      description: "Never settles.",
      parameters: { type: "object", properties: {} },
      preemptable: true,
      execute: () => new Promise<never>(() => {}),
    } as unknown as AgentTool;

    // The first response carries tool calls; while it "streams", a steer is
    // enqueued so it is already pending when the tool batch begins.
    let turn = 0;
    const streamFn: StreamFn = () => {
      const current = turn;
      turn += 1;
      const message =
        current === 0
          ? assistant([{ type: "toolCall", id: "t1", name: "hang", arguments: {} }], "toolUse")
          : assistant([{ type: "text", text: "stopped" }], "stop");
      return {
        async *[Symbol.asyncIterator]() {
          if (current === 0) {
            agentRef?.steer({ role: "user", content: "stop now", timestamp: 2 });
          }
          yield {
            type: "done" as const,
            reason: current === 0 ? ("toolUse" as const) : ("stop" as const),
            message,
          };
        },
        result: async () => message,
      };
    };

    agentRef = new Agent({
      initialState: { systemPrompt: "", model, thinkingLevel: "off", tools: [hangTool] },
      convertToLlm: (messages) => messages as Message[],
      streamFn,
      preemptOnSteer: true,
    });

    await agentRef.prompt("run hang");

    const messages = agentRef.state.messages;
    const toolResults = messages.filter((m) => m.role === "toolResult");
    expect(toolResults).toHaveLength(1);
    expect(JSON.stringify(toolResults[0]?.content)).toContain(
      "interrupted to handle a new user message",
    );
    const injectedSteer = messages.find(
      (m) => m.role === "user" && JSON.stringify(m.content ?? "").includes("stop now"),
    );
    expect(injectedSteer).toBeDefined();
  });
});
