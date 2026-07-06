# Harness Guardrails

The Harness Guardrails plugin adds opt-in verify/plan guardrails to **autonomous**
OpenClaw agent turns, built on existing agent hooks. It is bundled but **inert by
default** — every gate is off until you enable it in config, and it only applies to
autonomous run triggers (default: `cron`), so interactive chat turns are never affected.

## What it does

- **Quality gate** (`qualityCheck`): before an in-scope turn finalizes, if the workspace
  has uncommitted changes, it runs a configured command (default `pnpm check:changed`) and,
  on failure, asks the agent to revise using the failure output. It is bounded by the
  harness's revision cap (at most 3 passes) and is **pre-commit only** — the harness will
  not revise a turn that has already produced a deterministic side effect (e.g. a commit),
  so pair it with the plan nudge below. Infrastructure failures (timeout, spawn error) fail
  open and never block delivery.
- **Plan nudge** (`plan.mode: "prompt"`): injects a short system directive asking the agent
  to plan multi-step work and run checks before committing.

For genuine multi-step decomposition, use the Workboard `orchestration.autoDecompose`
feature instead — this plugin does not replace it.

## Configuration

Configure under the plugin's namespace. All gates default off:

```jsonc
{
  "plugins": {
    "entries": {
      "harness-guardrails": {
        "config": {
          "applyTo": { "triggers": ["cron"] },
          "qualityCheck": {
            "enabled": true,
            "command": ["pnpm", "check:changed"],
            "onlyWhenCodeChanged": true,
            "timeoutMs": 600000,
          },
          "plan": { "mode": "prompt" },
        },
      },
    },
  },
}
```

| Key                                | Default                    | Meaning                                                                                                                      |
| ---------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `applyTo.triggers`                 | `["cron"]`                 | Run triggers the guardrails apply to. Interactive (`user`/`manual`) turns are excluded.                                      |
| `applyTo.agents`                   | (all)                      | Optional agent-id allowlist.                                                                                                 |
| `qualityCheck.enabled`             | `false`                    | Turn the quality gate on.                                                                                                    |
| `qualityCheck.command`             | `["pnpm","check:changed"]` | Command run in the workspace. Point it at a lighter lane if the default is too slow.                                         |
| `qualityCheck.env`                 | `{ "CI": "1" }`            | Env merged over the process env. `CI=1` forces `check:changed` to run local lanes rather than delegating to a remote runner. |
| `qualityCheck.timeoutMs`           | `600000`                   | Bound on the check. On timeout the gate fails open.                                                                          |
| `qualityCheck.onlyWhenCodeChanged` | `true`                     | Only run when `git status` shows uncommitted changes.                                                                        |
| `plan.mode`                        | `"off"`                    | `"prompt"` injects the plan-first directive.                                                                                 |

## Notes

- Running heavy checks in-process on the gateway is why this is gated to autonomous
  triggers by default; keep it off the interactive path.
- The quality command runs as a bounded subprocess. It never runs `pnpm build`.
