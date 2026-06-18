/**
 * Workboard dispatcher — the execution driver that closes the LLM loop.
 *
 * The store is a deterministic state machine: it promotes dependency-ready cards,
 * blocks timed-out work, and flags triage cards as orchestration candidates, but
 * it never decides meaning or starts an agent. This module turns those signals
 * into running subagents:
 *   - orchestrator subagents (for flagged triage cards) call specify/decompose to
 *     turn an idea into a tree of child cards;
 *   - worker subagents (for ready cards) do the card and report via complete/block.
 *
 * Both are gated per-board on `orchestration.autoDecompose`, so a board that has
 * not opted in stays completely inert. The spawn is injected so the pass is unit
 * testable without the gateway agent runtime.
 */
import type { WorkboardStore } from "./store.js";
import type { WorkboardCard, WorkboardPriority } from "./types.js";

/** Starts a subagent run; production wires this to the gateway `agent` method. */
export type WorkboardSpawn = (params: {
  sessionKey: string;
  message: string;
  lane: string;
  idempotencyKey: string;
}) => Promise<{ runId: string }>;

export type WorkboardDispatchPassResult = {
  workersStarted: number;
  orchestratorsStarted: number;
  startFailures: number;
};

const DEFAULT_MAX_WORKERS = 3;
const WORKER_CLAIM_TTL_SECONDS = 30 * 60;
const PRIORITY_RANK: Record<WorkboardPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function cardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId ?? "default";
}

function hasActiveClaim(card: WorkboardCard, now: number): boolean {
  const claim = card.metadata?.claim;
  return Boolean(claim?.expiresAt && claim.expiresAt > now);
}

function subagentSuffix(card: WorkboardCard): string {
  return `workboard-${cardBoardId(card)}-${card.id}`;
}

// Deterministic per board+card so re-dispatch routes back to the same lane
// instead of spawning unrelated sessions. Assigned cards scope to their agent.
function workerSessionKey(card: WorkboardCard): string {
  const suffix = subagentSuffix(card);
  return card.agentId ? `agent:${card.agentId}:subagent:${suffix}` : `subagent:${suffix}`;
}

function orchestratorSessionKey(card: WorkboardCard): string {
  return `subagent:workboard-orchestrator-${cardBoardId(card)}-${card.id}`;
}

function compareReady(a: WorkboardCard, b: WorkboardCard): number {
  const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priority !== 0) {
    return priority;
  }
  if (a.position !== b.position) {
    return a.position - b.position;
  }
  return a.createdAt - b.createdAt;
}

function selectReadyWorkers(
  cards: readonly WorkboardCard[],
  enabledBoards: ReadonlySet<string>,
  max: number,
  now: number,
): WorkboardCard[] {
  const candidates = cards
    .filter(
      (card) =>
        card.status === "ready" &&
        enabledBoards.has(cardBoardId(card)) &&
        !card.metadata?.archivedAt &&
        !hasActiveClaim(card, now),
    )
    .toSorted(compareReady);
  // One start per owner/agent per pass so a single agent is not flooded.
  const seenAgents = new Set<string>();
  const picked: WorkboardCard[] = [];
  for (const card of candidates) {
    const owner = card.agentId ?? "(default)";
    if (seenAgents.has(owner)) {
      continue;
    }
    seenAgents.add(owner);
    picked.push(card);
    if (picked.length >= max) {
      break;
    }
  }
  return picked;
}

function workerMessage(card: WorkboardCard, context: string, token: string): string {
  return [
    `You are a Workboard worker. You have been dispatched card ${card.id} on board ${cardBoardId(card)}.`,
    context,
    `Your claim token is: ${token}`,
    `Do the work this card describes. Call workboard_heartbeat (id="${card.id}", claimToken) periodically so the card is not reclaimed. When the work is done, call workboard_complete (id="${card.id}", claimToken) with a short outcome summary. If you cannot proceed, call workboard_block (id="${card.id}", claimToken) with the reason.`,
  ].join("\n\n");
}

function orchestratorMessage(card: WorkboardCard, token: string): string {
  return [
    `You are a Workboard orchestrator. Card ${card.id} on board ${cardBoardId(card)} is a rough idea: "${card.title}".`,
    card.notes ? `Notes: ${card.notes}` : "",
    `Your claim token is: ${token}`,
    `Decide whether this idea is real and how to break it down. Use workboard_specify (id="${card.id}", claimToken) to clarify it into a concrete todo with a spec summary. Use workboard_decompose (id="${card.id}", claimToken) to split it into child cards — set each child's section to the next lane (a goal → implementations, an implementation → tasks). Keep children concrete and few.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Run one dispatcher pass: advance store state, then spawn orchestrators for
 * flagged triage cards and workers for ready cards on opted-in boards.
 */
export async function runWorkboardDispatchPass(opts: {
  store: WorkboardStore;
  spawn: WorkboardSpawn;
  now?: number;
  maxWorkers?: number;
  log?: (message: string) => void;
}): Promise<WorkboardDispatchPassResult> {
  const { store, spawn } = opts;
  const now = opts.now ?? Date.now();
  const maxWorkers = opts.maxWorkers ?? DEFAULT_MAX_WORKERS;
  const result: WorkboardDispatchPassResult = {
    workersStarted: 0,
    orchestratorsStarted: 0,
    startFailures: 0,
  };

  // Fully inert unless a board opted in: no data-side mutations, no spawns. Boards
  // that do not use the autonomous loop still advance via on-demand dispatch.
  const { boards } = await store.listBoards();
  const enabledBoards = new Set(
    boards.filter((board) => board.orchestration?.autoDecompose === true).map((board) => board.id),
  );
  if (enabledBoards.size === 0) {
    return result;
  }

  // Data-side lifecycle: promotes, blocks, reclaims, and flags orchestrated[].
  const dispatched = await store.dispatch(now);

  const spawnFor = async (
    card: WorkboardCard,
    role: "worker" | "orchestrator",
  ): Promise<"started" | "skipped" | "failed"> => {
    const sessionKey = role === "worker" ? workerSessionKey(card) : orchestratorSessionKey(card);
    let token: string;
    try {
      const claimed = await store.claim(card.id, {
        ownerId: sessionKey,
        ttlSeconds: WORKER_CLAIM_TTL_SECONDS,
      });
      token = claimed.token;
    } catch {
      // Already claimed (a prior pass still running) or not claimable — skip.
      return "skipped";
    }
    const message =
      role === "worker"
        ? workerMessage(card, await store.buildWorkerContext(card.id), token)
        : orchestratorMessage(card, token);
    try {
      await spawn({
        sessionKey,
        message,
        lane: `workboard:${cardBoardId(card)}`,
        idempotencyKey: `workboard-${role}-${card.id}-${now}`,
      });
      return "started";
    } catch (err) {
      // A claimed card whose worker never started would strand; block + release.
      await store.block(card.id, {
        ownerId: sessionKey,
        token,
        reason: `Worker start failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return "failed";
    }
  };

  // Orchestrators: dispatch already board-gated these via shouldAutoOrchestrate.
  for (const card of dispatched.orchestrated) {
    if (!enabledBoards.has(cardBoardId(card))) {
      continue;
    }
    const outcome = await spawnFor(card, "orchestrator");
    if (outcome === "started") {
      result.orchestratorsStarted += 1;
    } else if (outcome === "failed") {
      result.startFailures += 1;
    }
  }

  // Workers: ready cards on opted-in boards, bounded per pass.
  const ready = selectReadyWorkers(await store.list(), enabledBoards, maxWorkers, now);
  for (const card of ready) {
    const outcome = await spawnFor(card, "worker");
    if (outcome === "started") {
      result.workersStarted += 1;
    } else if (outcome === "failed") {
      result.startFailures += 1;
    }
  }

  if (result.workersStarted || result.orchestratorsStarted || result.startFailures) {
    opts.log?.(
      `workboard dispatch: started ${result.workersStarted} worker(s), ${result.orchestratorsStarted} orchestrator(s), ${result.startFailures} start failure(s)`,
    );
  }
  return result;
}
