# @openclaw/claude-connect

Open interactive **Claude Code** sessions from OpenClaw and delegate a coding
task or read-only research over multiple turns. Drives the supported `claude`
CLI stream-json interface directly — **no Agent SDK, no PTY/tmux scraping**.

## Tools

- `claude_session_open` — start a session (`mode: task | research`), returns a
  `handle`. Optional first `prompt`, `cwd`, `label`.
- `claude_session_send` — `{ handle, prompt }`; multi-turn, context preserved via
  `claude --resume`.
- `claude_session_close` — `{ handle }`; forget the session.

## Modes

- **task** — `--permission-mode acceptEdits`; Claude Code can write/edit/run in
  `cwd`. Rejected inside OpenClaw state dirs.
- **research** — read-only (`Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`;
  no `Write`/`Edit`/`Bash`).

## Enable

Set `plugins.entries.claude-connect.enabled: true` (opt-in; off by default). The
loader activates the plugin and registers the tools; the bundled skill becomes
eligible via the same flag.

## Config (`plugins.entries.claude-connect.config`)

- `defaultCwd` — fallback working directory.
- `binaryPath` — path to the `claude` binary (default: `claude` on PATH).
- `idleTurnTimeoutMs` — kill a turn after this much silence (default 120000).

Requires a locally authenticated `claude` CLI; no API key flows through OpenClaw.
