// CLI for the egress secret vault: add, list, rm, and set-hosts.
import type { Command } from "commander";
import { danger } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import {
  deleteVaultSecret,
  listVaultSecrets,
  saveVaultSecret,
  setVaultSecretHosts,
  type VaultApprovalPolicy,
  type VaultSecretInput,
} from "../secrets/vault/store.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";

type ClackPromptsModule = typeof import("@clack/prompts");

const clackPromptsLoader = createLazyImportLoader<ClackPromptsModule>(
  () => import("@clack/prompts"),
);

type VaultAddOptions = {
  hosts: string;
  username?: string;
  headerName?: string;
  policy?: string;
  value?: string;
};

type VaultListOptions = { json?: boolean };

function parseHosts(value: string): string[] {
  return value
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

function normalizePolicy(value: string | undefined): VaultApprovalPolicy {
  if (value === "auto") {
    return "auto";
  }
  if (value === undefined || value === "ask") {
    return "ask";
  }
  throw new Error(`Invalid --policy "${value}". Use "auto" or "ask".`);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Resolve the secret value from --value, piped stdin, or an interactive prompt. */
async function resolveSecretValue(explicit: string | undefined): Promise<string> {
  if (explicit && explicit.trim()) {
    return explicit;
  }
  const piped = await readStdin();
  if (piped.trim()) {
    return piped.replace(/\r?\n$/, "");
  }
  const prompts = await clackPromptsLoader.load();
  const entered = await prompts.password({ message: "Secret value" });
  if (prompts.isCancel(entered) || typeof entered !== "string" || !entered.trim()) {
    throw new Error("No secret value provided.");
  }
  return entered;
}

/** Build the store input from the chosen flags. Login kinds are UI-driven. */
function buildAddInput(
  name: string,
  hostAllowlist: string[],
  approvalPolicy: VaultApprovalPolicy,
  secret: string,
  opts: VaultAddOptions,
): VaultSecretInput {
  const common = { name, hostAllowlist, approvalPolicy };
  if (opts.username) {
    return { ...common, authKind: "basic", username: opts.username, password: secret };
  }
  if (opts.headerName) {
    return { ...common, authKind: "header", headers: [{ name: opts.headerName, value: secret }] };
  }
  return { ...common, authKind: "bearer", token: secret };
}

export function registerVaultCli(program: Command): void {
  const vault = program
    .command("vault")
    .description("Manage saved API credentials the agent uses without ever seeing them");

  vault
    .command("add <name>")
    .description("Save a credential bound to one or more hosts (value read from stdin or prompt)")
    .requiredOption("--hosts <hosts>", "Comma-separated host allowlist, e.g. api.stripe.com")
    .option("--username <username>", "Username for HTTP Basic auth (value becomes the password)")
    .option("--header-name <name>", "Inject the value into this custom header, e.g. X-API-Key")
    .option("--policy <policy>", 'Injection policy: "auto" (silent) or "ask" (prompt)', "ask")
    .option("--value <value>", "Secret value (discouraged; prefer stdin to avoid shell history)")
    .action(async (name: string, opts: VaultAddOptions) => {
      try {
        const hostAllowlist = parseHosts(opts.hosts);
        if (hostAllowlist.length === 0) {
          throw new Error("At least one --hosts entry is required.");
        }
        const approvalPolicy = normalizePolicy(opts.policy);
        const secret = await resolveSecretValue(opts.value);
        const input = buildAddInput(name, hostAllowlist, approvalPolicy, secret, opts);
        saveVaultSecret(input);
        defaultRuntime.log(
          `Saved vault secret "${name}" (${input.authKind}) for ${hostAllowlist.join(", ")} (policy: ${approvalPolicy}).`,
        );
      } catch (err) {
        defaultRuntime.error(danger(formatErrorMessage(err)));
        defaultRuntime.exit(1);
      }
    });

  vault
    .command("list")
    .description("List saved credentials (names and hosts only — values are never shown)")
    .option("--json", "Output JSON", false)
    .action((opts: VaultListOptions) => {
      const entries = listVaultSecrets();
      if (opts.json) {
        defaultRuntime.writeJson(entries);
        return;
      }
      if (entries.length === 0) {
        defaultRuntime.log("No saved credentials.");
        return;
      }
      for (const entry of entries) {
        defaultRuntime.log(
          `${entry.name}  [${entry.approvalPolicy}/${entry.authKind}]  ${entry.hostAllowlist.join(", ")}`,
        );
      }
    });

  vault
    .command("rm <name>")
    .description("Delete a saved credential and its approval grants")
    .action((name: string) => {
      deleteVaultSecret(name);
      defaultRuntime.log(`Deleted vault secret "${name}".`);
    });

  vault
    .command("set-hosts <name> <hosts>")
    .description("Replace the host allowlist for a saved credential (comma-separated)")
    .action((name: string, hosts: string) => {
      try {
        const hostAllowlist = parseHosts(hosts);
        if (hostAllowlist.length === 0) {
          throw new Error("At least one host is required.");
        }
        setVaultSecretHosts(name, hostAllowlist);
        defaultRuntime.log(`Updated hosts for "${name}": ${hostAllowlist.join(", ")}.`);
      } catch (err) {
        defaultRuntime.error(danger(formatErrorMessage(err)));
        defaultRuntime.exit(1);
      }
    });
}
