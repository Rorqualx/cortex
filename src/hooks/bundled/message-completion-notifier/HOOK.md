---
name: message-completion-notifier
description: "Notify another channel (e.g. Telegram) when the agent finishes a turn on a watched channel."
metadata:
  {
    "openclaw":
      {
        "emoji": "✅",
        "events": ["message:sent"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# message-completion-notifier

Forwards the agent's reply to a notification channel (e.g. Telegram) whenever
the agent finishes a turn on a watched channel. Intended as a lightweight
session-completion signal — for example, mirroring a Control UI (webchat) reply
to Telegram so an operator sees what the agent produced.

**Configuration** (inside `hooks.internal.entries.message-completion-notifier`):

| Field             | Type             | Default      | Description                                              |
| ----------------- | ---------------- | ------------ | -------------------------------------------------------- |
| `enabled`         | boolean          | `true`       | Set to `false` to disable the hook.                      |
| `watchChannel`    | string           | `"webchat"`  | Channel to watch for outgoing messages.                  |
| `notifyChannel`   | string           | `"telegram"` | Channel to send the notification to.                     |
| `notifyTo`        | string           | _(required)_ | Recipient on the notification channel (e.g. chat ID).    |
| `notifyAccountId` | string           | _(required)_ | Account ID for the notification channel.                 |
| `notifyThreadId`  | string \| number | _(optional)_ | Thread ID on the notification channel.                   |
| `message`         | string           | `"✅ Done"`  | Fallback text sent only when the turn produced no reply. |

The hook is **best-effort / fire-and-forget** — it never throws and will not
block or fail the original message delivery.
