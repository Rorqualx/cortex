---
events:
  - message:sent
---

# message-completion-notifier

Sends a short "done" summary to a notification channel (e.g. Telegram) whenever
the agent sends a message on a watched channel. Intended as a lightweight
session-completion signal — for example, notifying an operator that a webchat
interaction has finished.

**Configuration** (inside `hooks.internal.entries.message-completion-notifier`):

| Field             | Type             | Default      | Description                                           |
| ----------------- | ---------------- | ------------ | ----------------------------------------------------- |
| `enabled`         | boolean          | `true`       | Set to `false` to disable the hook.                   |
| `watchChannel`    | string           | `"webchat"`  | Channel to watch for outgoing messages.               |
| `notifyChannel`   | string           | `"telegram"` | Channel to send the notification to.                  |
| `notifyTo`        | string           | _(required)_ | Recipient on the notification channel (e.g. chat ID). |
| `notifyAccountId` | string           | _(required)_ | Account ID for the notification channel.              |
| `notifyThreadId`  | string \| number | _(optional)_ | Thread ID on the notification channel.                |
| `message`         | string           | `"✅ Done"`  | Notification text template.                           |

The hook is **best-effort / fire-and-forget** — it never throws and will not
block or fail the original message delivery.
