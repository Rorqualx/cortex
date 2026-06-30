---
name: claude-connect
description: "Open an interactive Claude Code session and delegate a coding task (write/edit/run) or read-only research; multi-turn chat over the claude CLI, no Agent SDK. Not for simple edits you can do directly or one-shot background workers (use coding-agent for fire-and-forget)."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔌",
        "skillKey": "claude-connect",
        "requires": { "bins": ["claude"], "config": ["plugins.entries.claude-connect.enabled"] },
        "install":
          [
            {
              "id": "node-claude",
              "kind": "node",
              "package": "@anthropic-ai/claude-code",
              "bins": ["claude"],
              "label": "Install Claude Code CLI (npm)",
            },
          ],
      },
  }
---

# Claude Connect

Drive an interactive **Claude Code** session from OpenClaw: open a session, chat
over multiple turns, and either have Claude Code **do a task** (write/edit/run in
a repo) or **do research** (read-only). Runs the supported `claude` CLI
stream-json interface directly — no Agent SDK, no PTY/tmux scraping.

## When to use

- Multi-turn delegation where you send a prompt, read the reply, then follow up.
- Hand a coding task to Claude Code and iterate on it.
- Ask Claude Code to investigate a repo / the web and report back, read-only.

Do **not** use for: trivial edits you can make yourself; one-shot fire-and-forget
background workers (use the `coding-agent` skill); ACP-thread-bound work (use the
`acp-router` skill).

## Tools

- `claude_session_open` — start a session, returns a `handle`. Params: `mode`
  (`task` | `research`), optional `prompt` (first message), optional `cwd`,
  optional `label`.
- `claude_session_send` — `{ handle, prompt }`. Continue the conversation; full
  context is preserved across turns.
- `claude_session_close` — `{ handle }`. Forget the session.

## Modes

- **task** — Claude Code may edit files and run commands in `cwd`
  (`--permission-mode acceptEdits`). Always pass an explicit `cwd` pointing at
  the target repo.
- **research** — read-only: `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`
  only; `Write`/`Edit`/`Bash` are blocked.

## Rules

- For `task` mode, set `cwd` to an isolated working checkout. Never run `task`
  mode inside `~/.openclaw`, `$OPENCLAW_STATE_DIR`, or the OpenClaw source repo
  (state-dir paths are rejected automatically).
- Keep one `handle` per ongoing conversation; reuse it for follow-ups instead of
  opening a new session each turn.
- Requires a locally authenticated `claude` CLI (subscription or OAuth login);
  the plugin passes no API key.
- Relay the final answer (tool `content`) back to the user; the live progress
  lines are previews, not the result.
- Close the session when the conversation is done.

## Typical flow

1. `claude_session_open` with `mode` and (optionally) a first `prompt`; keep the
   returned `handle`.
2. `claude_session_send` `{ handle, prompt }` for each follow-up.
3. `claude_session_close` `{ handle }` when finished.
