/**
 * Workboard CLI subcommands — core-native replacement for extensions/workboard/src/cli.ts.
 */
import type { Command } from "commander";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveWorkboardCardByIdOrPrefix } from "../../workboard/card-lookup.js";
import type { WorkboardStore as WbStore } from "../../workboard/store.js";
import type { WorkboardCard } from "../../workboard/types.js";
import { callGatewayFromCli } from "../gateway-rpc.js";

// ── Helpers ────────────────────────────────────────────────────────

// Read through the shared state DB — the same canonical store the gateway
// serves — so CLI `list`/`show` see cards created via the gateway and vice
// versa. Dynamic import keeps core-db-store off the eager CLI import graph.
async function resolveStore(): Promise<WbStore> {
  const { openWorkboardCoreStore } = await import("../../workboard/core-db-store.js");
  return openWorkboardCoreStore();
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
        const store = await resolveStore();
        const cards = await store.list({ boardId: opts.board as string | undefined });
        // list() filters by board only; apply status/section at the CLI layer.
        const status = opts.status as string | undefined;
        const section = opts.section as string | undefined;
        const result = cards.filter(
          (card) => (!status || card.status === status) && (!section || card.section === section),
        );
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

  wb.command("research-sync")
    .description(
      "Ingest the daily-research reports into the Recursive Self-Improvement Laboratory board",
    )
    .option("--reports-dir <dir>", "Override the reports directory")
    .option("--assignee <agentId>", "Default assignee for newly created cards")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      try {
        const { runResearchIngest, resolveResearchReportsDir } =
          await import("../../workboard/research-ingest.js");
        const store = await resolveStore();
        const reportsDir =
          (opts.reportsDir as string | undefined)?.trim() || resolveResearchReportsDir();
        const result = await runResearchIngest({
          store,
          reportsDir,
          defaultAssignee: opts.assignee as string | undefined,
        });
        if (opts.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          process.stdout.write(
            `Research sync → board ${result.boardId}\n` +
              `  cycles: ${result.cyclesProcessed.join(", ") || "none"}\n` +
              `  created ${result.created}, updated ${result.updated}, ` +
              `preserved ${result.skippedUserTouched}, archived ${result.archived}\n` +
              (result.warnings.length > 0 ? `  warnings: ${result.warnings.length}\n` : ""),
          );
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
        const store = await resolveStore();
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
      try {
        const result = await callGatewayFromCli("workboard.cards.create", opts, {
          title,
          notes: opts.notes as string | undefined,
          status: opts.status as string,
          priority: opts.priority as string,
          agentId: opts.agent as string | undefined,
        });
        const data = (result as { card?: unknown })?.card;
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
        const store = await resolveStore();
        if (opts.dryRun) {
          // Read-only preview. store.dispatch() mutates (promotes/blocks/claims),
          // so a dry run must not call it — especially now that the CLI shares the
          // gateway's canonical DB. Report the current actionable card counts.
          const cards = await store.list();
          const count = (status: string) => cards.filter((card) => card.status === status).length;
          process.stdout.write(
            [
              `ready: ${count("ready")}`,
              `running: ${count("running")}`,
              `blocked: ${count("blocked")}`,
              `triage: ${count("triage")}`,
            ].join("\n") + "\n",
          );
        } else {
          const result = await callGatewayFromCli("workboard.cards.dispatch", opts, {
            maxStarts: Number(opts.maxStarts),
          });
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        }
      } catch (error) {
        process.stderr.write(`Error: ${formatErrorMessage(error)}\n`);
        process.exitCode = 1;
      }
    });
}
