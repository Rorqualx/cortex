---
name: vault
description: "Manage saved API and SSH credentials in the egress vault — add, list, delete, and understand how injection works."
---

# Egress Vault

The vault stores encrypted credentials that the runtime injects into outbound requests and SSH commands. The agent never sees secret material — only metadata (name, auth kind, hosts).

## Auth kinds

| Kind     | Use                         | Injection                                                                      |
| -------- | --------------------------- | ------------------------------------------------------------------------------ |
| `bearer` | API token                   | `Authorization: Bearer <token>` header                                         |
| `basic`  | Username + password         | `Authorization: Basic <base64>` header                                         |
| `header` | Custom header(s)            | Named header(s) injected on allowlisted hosts                                  |
| `login`  | Login form → session token  | POSTs creds, captures cookie/header token, replays with TTL caching            |
| `ssh`    | SSH private key or password | Rewrites `ssh`/`scp`/`rsync`/`sftp` commands with `-i` keyfile or `sshpass -e` |

## SSH injection details

When the agent runs an SSH-family command targeting a vault-allowlisted host, the runtime:

1. Detects the tool (`ssh`, `scp`, `rsync`, `sftp`) and extracts the target host
2. Matches against vault entries with `authKind: "ssh"`
3. Rewrites the command:
   - **Private key**: writes PEM to 0600 temp file, injects `-i <file>`, cleans up after exit
   - **Password**: wraps with `sshpass -e`, sets `SSHPASS` env var
   - **Username**: prepends `user@host` if not already in the command
   - **Port**: adds `-p`/`-P` if not already specified
   - **Options**: `StrictHostKeyChecking=accept-new` + `BatchMode=yes` (key auth only)

The agent sees only a warning: `SSH credentials for <host> injected from vault entry "<name>".`

## CLI

```bash
# SSH with password
openclaw vault add swamp --ssh --hosts 192.168.50.101 --username joe --password

# SSH with private key
openclaw vault add prod --ssh --hosts prod.example.com --key-file ~/.ssh/id_ed25519 --username deploy --port 2222

# Bearer token
openclaw vault add stripe --hosts api.stripe.com --policy auto

# List
openclaw vault list

# Delete
openclaw vault rm swamp
```

## Gateway protocol

- `vault.list` — returns metadata-only entries (no secret values)
- `vault.save` — encrypts and stores; accepts `authKind: bearer|basic|header|login|ssh`
- `vault.delete` — removes entry + grants + cached sessions

## Key files

| File                                            | Purpose                               |
| ----------------------------------------------- | ------------------------------------- |
| `src/secrets/vault/store.ts`                    | Core CRUD, types, encryption, catalog |
| `src/secrets/vault/crypto.ts`                   | AES-256-GCM with vault.key            |
| `src/secrets/vault/ssh-injection.ts`            | SSH command detection + rewriting     |
| `src/agents/tools/http-request.ts`              | HTTP credential injection point       |
| `src/agents/tools/vault-login.ts`               | Stateful login flow                   |
| `src/agents/bash-tools.exec-runtime.ts`         | SSH injection point (pre-spawn hook)  |
| `src/cli/vault-cli.ts`                          | CLI commands                          |
| `src/gateway/server-methods/vault.ts`           | Gateway RPC handlers                  |
| `packages/gateway-protocol/src/schema/vault.ts` | TypeBox schema                        |
| `ui/src/ui/components/vault-credential-form.ts` | UI add-credential form                |

## Security model

- Secrets encrypted at rest with AES-256-GCM (`vault.key`, 0600)
- Secret material never returned by `list` — only decrypted at moment of use
- All secret fields registered for log redaction before network use
- Host allowlist enforced (exact + subdomain matching, never bare suffix)
- SSH temp key files get 0600 perms, cleaned up on process exit (success + error)
- `sshpass -e` used instead of `-p` to avoid process list exposure
- `StrictHostKeyChecking=accept-new` (not `no`) — accepts new keys, rejects changed ones
