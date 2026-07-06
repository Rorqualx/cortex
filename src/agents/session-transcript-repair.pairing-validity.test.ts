// Land-gate coverage for the pairing-validity fast-path (Workstream ①).
//
// The outbound id sanitizer skips the O(N^2) `sanitizeToolUseResultPairing` pass
// when `isToolUseResultPairingValid` holds. Two invariants keep that safe:
//   (A) soundness — `isToolUseResultPairingValid(m) === true` implies the repair
//       changes NO content, so skipping is byte-identical.
//   (B) end-to-end — the gated `sanitizeReplayToolCallIdsForStream` output equals
//       the ungated (always-repair) output for valid AND adversarial transcripts.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../agents/tool-call-id.js";
import { sanitizeReplayToolCallIdsForStream } from "./embedded-agent-runner/run/attempt.tool-call-normalization.js";
import {
  isToolUseResultPairingValid,
  sanitizeToolUseResultPairing,
} from "./session-transcript-repair.js";

function assistant(
  calls: Array<{ id: string; name: string }>,
  extra: Record<string, unknown> = {},
): AgentMessage {
  return {
    role: "assistant",
    stopReason: "toolUse",
    content: calls.map((call) => ({
      type: "toolUse",
      id: call.id,
      name: call.name,
      input: { q: call.id },
    })),
    ...extra,
  } as never;
}

function toolResult(id: string, name: string, extra: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: `result ${id}` }],
    isError: false,
    ...extra,
  } as never;
}

const userMsg = { role: "user", content: "next" } as unknown as AgentMessage;
const assistantText = {
  role: "assistant",
  stopReason: "stop",
  content: "note",
} as unknown as AgentMessage;

type Case = {
  label: string;
  messages: AgentMessage[];
  valid: boolean;
};

const CASES: Case[] = [
  {
    label: "single canonical call+result",
    messages: [assistant([{ id: "callone", name: "read" }]), toolResult("callone", "read")],
    valid: true,
  },
  {
    label: "multi-call results in call order",
    messages: [
      assistant([
        { id: "callA", name: "read" },
        { id: "callB", name: "grep" },
      ]),
      toolResult("callA", "read"),
      toolResult("callB", "grep"),
    ],
    valid: true,
  },
  {
    label: "multiple turns interleaved with user/text",
    messages: [
      userMsg,
      assistant([{ id: "callone", name: "read" }]),
      toolResult("callone", "read"),
      assistantText,
      userMsg,
      assistant([{ id: "calltwo", name: "read" }]),
      toolResult("calltwo", "read"),
    ],
    valid: true,
  },
  {
    label: "long clean transcript",
    messages: Array.from({ length: 40 }, (_, i) => [
      assistant([{ id: `callx${i}`, name: "read" }]),
      toolResult(`callx${i}`, "read"),
    ]).flat(),
    valid: true,
  },
  {
    label: "errored assistant turn",
    messages: [
      assistant([{ id: "callone", name: "read" }], { stopReason: "error" }),
      toolResult("callone", "read"),
    ],
    valid: false,
  },
  {
    label: "aborted assistant turn",
    messages: [
      assistant([{ id: "callone", name: "read" }], { stopReason: "aborted" }),
      toolResult("callone", "read"),
    ],
    valid: false,
  },
  {
    label: "orphan/free-floating tool result",
    messages: [
      toolResult("callone", "read"),
      assistant([{ id: "calltwo", name: "read" }]),
      toolResult("calltwo", "read"),
    ],
    valid: false,
  },
  {
    label: "duplicate result for same id",
    messages: [
      assistant([{ id: "callone", name: "read" }]),
      toolResult("callone", "read"),
      toolResult("callone", "read"),
    ],
    valid: false,
  },
  {
    label: "missing result (needs synth)",
    messages: [
      assistant([
        { id: "callA", name: "read" },
        { id: "callB", name: "grep" },
      ]),
      toolResult("callA", "read"),
    ],
    valid: false,
  },
  {
    label: "misordered results",
    messages: [
      assistant([
        { id: "callA", name: "read" },
        { id: "callB", name: "grep" },
      ]),
      toolResult("callB", "grep"),
      toolResult("callA", "read"),
    ],
    valid: false,
  },
  {
    label: "untrimmed toolName (name normalization)",
    messages: [assistant([{ id: "callone", name: "read" }]), toolResult("callone", " read ")],
    valid: false,
  },
  {
    label: "result missing id, single call (legacy id assign)",
    messages: [
      assistant([{ id: "callone", name: "read" }]),
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x" }] } as never,
    ],
    valid: false,
  },
  {
    label: "displaced result (user between call and result)",
    messages: [
      assistant([{ id: "callone", name: "read" }]),
      userMsg,
      toolResult("callone", "read"),
    ],
    valid: false,
  },
  {
    label: "raw underscored ids, canonical pairing",
    messages: [assistant([{ id: "call_one", name: "read" }]), toolResult("call_one", "read")],
    // id-sanitize rewrites the ids, but pairing stays canonical after rewrite; the
    // predicate runs on the sanitized transcript, so this still fast-paths.
    valid: true,
  },
];

describe("isToolUseResultPairingValid", () => {
  it("classifies each transcript as expected", () => {
    for (const testCase of CASES) {
      const sanitized = sanitizeToolCallIdsForCloudCodeAssist(testCase.messages, "strict", {
        allowedToolNames: ["read", "grep"],
      });
      expect({ label: testCase.label, valid: isToolUseResultPairingValid(sanitized) }).toEqual({
        label: testCase.label,
        valid: testCase.valid,
      });
    }
  });

  it("soundness: valid transcripts are a repair no-op (content-identical)", () => {
    for (const testCase of CASES) {
      const sanitized = sanitizeToolCallIdsForCloudCodeAssist(testCase.messages, "strict", {
        allowedToolNames: ["read", "grep"],
      });
      if (!isToolUseResultPairingValid(sanitized)) {
        continue;
      }
      // Repair must leave the sanitized transcript byte-identical in content.
      expect(sanitizeToolUseResultPairing(sanitized)).toEqual(sanitized);
    }
  });

  it("end-to-end: gated output byte-identical to ungated for every transcript", () => {
    // Some invalid cases synthesize a missing tool result stamped with Date.now();
    // freeze it so the gated and ungated repair runs produce identical timestamps.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      for (const testCase of CASES) {
        const gated = sanitizeReplayToolCallIdsForStream({
          messages: testCase.messages,
          mode: "strict",
          allowedToolNames: new Set(["read", "grep"]),
          repairToolUseResultPairing: true,
        });
        // Ungated reference: always run the pairing repair after id sanitize.
        const idSanitized = sanitizeToolCallIdsForCloudCodeAssist(testCase.messages, "strict", {
          allowedToolNames: ["read", "grep"],
        });
        const ungated = sanitizeToolUseResultPairing(idSanitized);
        expect({ label: testCase.label, out: gated }).toEqual({
          label: testCase.label,
          out: ungated,
        });
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("covers both branches (at least one valid and one repaired case)", () => {
    const flags = CASES.map((c) =>
      isToolUseResultPairingValid(
        sanitizeToolCallIdsForCloudCodeAssist(c.messages, "strict", {
          allowedToolNames: ["read", "grep"],
        }),
      ),
    );
    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });

  it("soundness holds exhaustively across generated transcript shapes (drift guard)", () => {
    // Enumerate every transcript of length <= 3 over a primitive alphabet covering the
    // shapes the repair distinguishes, so predicate/repair drift on shapes the fixed
    // CASES list does not enumerate is still caught. For every generated transcript the
    // gated fast-path must equal the always-repair reference; when the predicate accepts
    // a transcript, the repair must additionally be a content no-op.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const primitives: Record<string, () => AgentMessage> = {
        A1: () => assistant([{ id: "caa", name: "read" }]),
        A2: () =>
          assistant([
            { id: "caa", name: "read" },
            { id: "cbb", name: "grep" },
          ]),
        Aerr: () => assistant([{ id: "caa", name: "read" }], { stopReason: "error" }),
        At: () => assistantText,
        Ra: () => toolResult("caa", "read"),
        Rb: () => toolResult("cbb", "grep"),
        Rau: () => toolResult("caa", " read "),
        Rni: () =>
          ({
            role: "toolResult",
            toolName: "read",
            content: [{ type: "text", text: "x" }],
          }) as never,
        U: () => userMsg,
      };
      const keys = Object.keys(primitives);
      const allowedToolNames = ["read", "grep"];
      let validCount = 0;
      let repairedCount = 0;

      const check = (combo: string[]) => {
        const messages = combo.map((key) => primitives[key]!());
        const sanitized = sanitizeToolCallIdsForCloudCodeAssist(messages, "strict", {
          allowedToolNames,
        });
        if (isToolUseResultPairingValid(sanitized)) {
          validCount += 1;
          expect({ combo, out: sanitizeToolUseResultPairing(sanitized) }).toEqual({
            combo,
            out: sanitized,
          });
        } else {
          repairedCount += 1;
        }
        const gated = sanitizeReplayToolCallIdsForStream({
          messages,
          mode: "strict",
          allowedToolNames: new Set(allowedToolNames),
          repairToolUseResultPairing: true,
        });
        const ungated = sanitizeToolUseResultPairing(
          sanitizeToolCallIdsForCloudCodeAssist(messages, "strict", { allowedToolNames }),
        );
        expect({ combo, out: gated }).toEqual({ combo, out: ungated });
      };

      for (const a of keys) {
        check([a]);
        for (const b of keys) {
          check([a, b]);
          for (const c of keys) {
            check([a, b, c]);
          }
        }
      }
      // Guard the guard: confirm the alphabet actually exercises both branches broadly.
      expect(validCount).toBeGreaterThan(10);
      expect(repairedCount).toBeGreaterThan(100);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
