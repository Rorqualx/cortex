/**
 * Workboard agent tools.
 *
 * These let an agent drive the Workboard loop that the store + dispatcher set up
 * but cannot decide on their own:
 *  - orchestrator agents call workboard_specify / workboard_decompose to turn a
 *    rough idea into a clarified card and a tree of child cards (goals →
 *    implementations → tasks);
 *  - worker agents call workboard_heartbeat / workboard_complete / workboard_block
 *    to report on the card they were dispatched, authorized by the claim token
 *    handed to them in their prompt.
 *
 * Each tool is a thin wrapper over a `workboard.cards.*` gateway RPC.
 */
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

type GatewayCaller = typeof callGateway;

type WorkboardToolDeps = {
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
};

// A claim token authorizes mutating a card another actor has claimed. Sent as
// both `token` (read by complete/block/heartbeat) and `claimToken` (read by the
// specify/decompose scope helper) so either store path accepts it.
function claimParams(params: Record<string, unknown>): Record<string, unknown> {
  const token = readStringParam(params, "claimToken");
  return token ? { token, claimToken: token } : {};
}

async function call(
  deps: WorkboardToolDeps,
  method: string,
  params: Record<string, unknown>,
): Promise<ReturnType<typeof jsonResult>> {
  const gatewayCall = deps.callGateway ?? callGateway;
  try {
    const result = await gatewayCall<Record<string, unknown>>({ method, params });
    return jsonResult({ status: "ok", ...result });
  } catch (err) {
    return jsonResult({ status: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

const SectionSchema = Type.Optional(
  Type.String({
    description: "Lane for the card: goals | implementations | tasks | ideas.",
  }),
);

const DecomposeChildSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  section: SectionSchema,
  notes: Type.Optional(Type.String({ maxLength: 4000 })),
  priority: Type.Optional(Type.String({ description: "low | normal | high | urgent" })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
});

/** Build the Workboard agent tools (list/read + specify/decompose + worker lifecycle). */
export function createWorkboardTools(deps: WorkboardToolDeps = {}): AnyAgentTool[] {
  const listTool: AnyAgentTool = {
    name: "workboard_list",
    label: "Workboard list",
    description:
      "List Workboard cards, optionally filtered by board, status, or section (goals/implementations/tasks/ideas).",
    parameters: Type.Object({
      boardId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      status: Type.Optional(Type.String()),
      section: SectionSchema,
    }),
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const gatewayCall = deps.callGateway ?? callGateway;
      const boardId = readStringParam(params, "boardId");
      const status = readStringParam(params, "status");
      const section = readStringParam(params, "section");
      try {
        const result = await gatewayCall<{ cards?: Array<Record<string, unknown>> }>({
          method: "workboard.cards.list",
          params: boardId ? { boardId } : {},
        });
        const cards = (Array.isArray(result?.cards) ? result.cards : []).filter(
          (card) => (!status || card.status === status) && (!section || card.section === section),
        );
        return jsonResult({ status: "ok", count: cards.length, cards });
      } catch (err) {
        return jsonResult({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };

  const readTool: AnyAgentTool = {
    name: "workboard_read",
    label: "Workboard read",
    description: "Read a single Workboard card by id, including notes, links, and metadata.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      return call(deps, "workboard.cards.read", { id: readStringParam(params, "id") });
    },
  };

  const specifyTool: AnyAgentTool = {
    name: "workboard_specify",
    label: "Workboard specify",
    description:
      "Clarify a rough triage/backlog/todo card: record a spec summary and move it to todo. Use this to judge whether an idea is real and state what it actually is.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      summary: Type.Optional(Type.String({ maxLength: 2000 })),
      claimToken: Type.Optional(Type.String()),
    }),
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      return call(deps, "workboard.cards.specify", {
        id: readStringParam(params, "id"),
        ...(readStringParam(params, "summary")
          ? { summary: readStringParam(params, "summary") }
          : {}),
        ...claimParams(params),
      });
    },
  };

  const decomposeTool: AnyAgentTool = {
    name: "workboard_decompose",
    label: "Workboard decompose",
    description:
      "Break a parent card into linked child cards (up to 20). Use this to turn a goal into implementations, or an implementation into tasks — set each child's section to the next lane. The parent is completed unless completeParent is false.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      children: Type.Array(DecomposeChildSchema, { minItems: 1, maxItems: 20 }),
      summary: Type.Optional(Type.String({ maxLength: 2000 })),
      completeParent: Type.Optional(Type.Boolean()),
      claimToken: Type.Optional(Type.String()),
    }),
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      return call(deps, "workboard.cards.decompose", {
        id: readStringParam(params, "id"),
        children: Array.isArray(params.children) ? params.children : [],
        ...(readStringParam(params, "summary")
          ? { summary: readStringParam(params, "summary") }
          : {}),
        ...(typeof params.completeParent === "boolean"
          ? { completeParent: params.completeParent }
          : {}),
        ...claimParams(params),
      });
    },
  };

  const heartbeatTool: AnyAgentTool = {
    name: "workboard_heartbeat",
    label: "Workboard heartbeat",
    description:
      "Keep your claim on a card alive while you work it. Pass the claim token from your dispatch prompt.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      note: Type.Optional(Type.String({ maxLength: 400 })),
      claimToken: Type.Optional(Type.String()),
    }),
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      return call(deps, "workboard.cards.heartbeat", {
        id: readStringParam(params, "id"),
        ...(readStringParam(params, "note") ? { note: readStringParam(params, "note") } : {}),
        ...claimParams(params),
      });
    },
  };

  const completeTool: AnyAgentTool = {
    name: "workboard_complete",
    label: "Workboard complete",
    description:
      "Mark the card you were dispatched as done, with a short outcome summary. Pass the claim token from your dispatch prompt.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      summary: Type.Optional(Type.String({ maxLength: 2000 })),
      claimToken: Type.Optional(Type.String()),
    }),
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      return call(deps, "workboard.cards.complete", {
        id: readStringParam(params, "id"),
        ...(readStringParam(params, "summary")
          ? { summary: readStringParam(params, "summary") }
          : {}),
        ...claimParams(params),
      });
    },
  };

  const blockTool: AnyAgentTool = {
    name: "workboard_block",
    label: "Workboard block",
    description:
      "Block the card you were dispatched when you cannot make progress, with a reason. Pass the claim token from your dispatch prompt.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      reason: Type.Optional(Type.String({ maxLength: 2000 })),
      claimToken: Type.Optional(Type.String()),
    }),
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      return call(deps, "workboard.cards.block", {
        id: readStringParam(params, "id"),
        ...(readStringParam(params, "reason") ? { reason: readStringParam(params, "reason") } : {}),
        ...claimParams(params),
      });
    },
  };

  const researchSyncTool: AnyAgentTool = {
    name: "workboard_research_sync",
    label: "Workboard research sync",
    description:
      "Ingest the daily-research reports (llm-research / openclaw-analysis / implementation) into the Recursive Self-Improvement Laboratory board: create/update cards, mark implemented items done, and queue un-done quick-wins as 'ready'. Idempotent — safe to run every cycle. Returns created/updated/archived counts.",
    parameters: Type.Object({
      defaultAssignee: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 64,
          description: "Agent id to own newly created cards (e.g. the implementation agent).",
        }),
      ),
      reportsDir: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    }),
    execute: async (_id, args) => {
      const params = args as Record<string, unknown>;
      const assignee = readStringParam(params, "defaultAssignee");
      const reportsDir = readStringParam(params, "reportsDir");
      return call(deps, "workboard.research.sync", {
        ...(assignee ? { defaultAssignee: assignee } : {}),
        ...(reportsDir ? { reportsDir } : {}),
      });
    },
  };

  return [
    listTool,
    readTool,
    specifyTool,
    decomposeTool,
    heartbeatTool,
    completeTool,
    blockTool,
    researchSyncTool,
  ];
}
