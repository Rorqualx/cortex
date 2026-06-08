/**
 * Workboard CLI subcommands — core-native replacement for extensions/workboard/src/cli.ts.
 */
import type { Command } from "commander";
import { addGatewayClientOptions, callGatewayFromCli } from "../cli/gateway-rpc.js";
import { getRuntimeConfig } from "../config/runtime-snapshot.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveWorkboardCardByIdOrPrefix } from "../workboard/card-lookup.js";
import { WorkboardStore } from "../workboard/store.js";
import type { WorkboardDispatchResult, WorkboardStore as WbStore } from "../workboard/store.js";
import type { WorkboardCard } from "../workboard/types.js";

// ── Helpers ────────────────────────────────────────────────────────

function resolveStore(): WbStore {
  return WorkboardStore.openSqlite();
}

async function formatCards(cards: WorkboardCard[], label: string): Promise<string> {
  if (cards.length === 0) {
    return "No cards found.";
  }
  const lines = [`${label} (${cards.length}):`];
  for (const card of cards) {
    lines.push(
      `  ${card.id}  [${card.status}]  ${card.title}` +
        (card.metadata?.claim?.ownerId ? `  (claimed by ${card.metadata.claim.ownerId})` : ""),
    );
  }
  return lines.join("\n");
}

// ── Command registration ───────────────────────────────────────────

export function registerWorkboardCli(program: Command) {
  const wb = program.command("workboard").description("Manage Workboard cards and worker dispatch");

  wb.command("list")
    .description("List workboard cards")
    .option("--status <status>", "Filter by status")
    .option("--section <section>", "Filter by section")
    .option("--board <id>", "Filter by board")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      try {
        const store = resolveStore();
        const result = await store.list({
          status: opts.status as string | undefined,
          section: opts.section as string | undefined,
          boardId: opts.board as string | undefined,
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          process.stdout.write((await formatCards(result, "Workboard cards")) + "\n");
        }
      } catch (error) {
        process.stderr.write(`Error: ${formatErrorMessage(error)}\n`);
        process.exitCode = 1;
      }
    });

  wb.command("show <id>")
    .description("Show card details")
    .action(async (id: string) => {
      try {
        const store = resolveStore();
        const entries = await store.list();
        const card = resolveWorkboardCardByIdOrPrefix(entries, id);
        if (!card) {
          process.stderr.write(`Card not found: ${id}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(JSON.stringify(card, null, 2) + "\n");
      } catch (error) {
        process.stderr.write(`Error: ${formatErrorMessage(error)}\n`);
        process.exitCode = 1;
      }
    });

  wb.command("create <title>")
    .description("Create a workboard card")
    .option("--notes <notes>", "Card notes")
    .option("--status <status>", "Initial status", "todo")
    .option("--priority <priority>", "Priority (low/normal/high/urgent)", "normal")
    .option("--agent <agentId>", "Assigned agent")
    .action(async (title: string, opts) => {
      const config = getRuntimeConfig() ?? {};
      try {
        const result = await callGatewayFromCli(
          "workboard.cards.create-card",
          {
            title,
            notes: opts.notes as string | undefined,
            status: opts.status as string,
            priority: opts.priority as string,
            agentId: opts.agent as string | undefined,
          },
          config,
        );
        const data = (result as { response?: unknown })?.response;
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      } catch (error) {
        process.stderr.write(`Error: ${formatErrorMessage(error)}\n`);
        process.exitCode = 1;
      }
    });

  wb.command("dispatch")
    .description("Run dispatch: promote ready cards and start worker subagents")
    .option("--max-starts <n>", "Max concurrent subagent starts", "3")
    .option("--dry-run", "Show what would happen without starting workers")
    .action(async (opts) => {
      try {
        const store = resolveStore();
        if (opts.dryRun) {
          const result: WorkboardDispatchResult = await store.dispatch(Date.now());
          process.stdout.write(
            [
              `promoted: ${result.promoted.length}`,
              `blocked: ${result.blocked.length}`,
              `reclaimed: ${result.reclaimed.length}`,
              `orchestrated: ${result.orchestrated.length}`,
            ].join("\n") + "\n",
          );
        } else {
          const config = getRuntimeConfig() ?? {};
          const result = await callGatewayFromCli(
            "workboard.cards.dispatch",
            {
              maxStarts: Number(opts.maxStarts),
            },
            config,
          );
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        }
      } catch (error) {
        process.stderr.write(`Error: ${formatErrorMessage(error)}\n`);
        process.exitCode = 1;
      }
    });
}
