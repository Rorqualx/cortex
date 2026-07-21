// Control UI tests cover exec approval behavior.
import { html, render } from "lit";
import { expect, test } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ExecApprovalRequest } from "../controllers/exec-approval.ts";
import { renderExecApprovalCard } from "./exec-approval-card.ts";

const root = document.createElement("div");
document.body.append(root);

test("renders command spans in Chromium approval modal", async () => {
  await i18n.setLocale("en");
  const approval: ExecApprovalRequest = {
    id: "approval-browser-1",
    kind: "exec",
    request: {
      command: 'ls | grep "stuff" | python -c \'print("hi")\'',
      host: "gateway",
      security: "allowlist",
      ask: "always",
      commandSpans: [
        { startIndex: 0, endIndex: 2 },
        { startIndex: 20, endIndex: 29 },
      ],
    },
    createdAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 60_000,
  };
  render(
    renderExecApprovalCard({
      approval,
      busy: false,
      error: null,
      nowMs: Date.now(),
      variant: "modal",
      onDecision: async () => undefined,
    }),
    root,
  );

  const spans = [...root.querySelectorAll(".exec-approval-command-span")].map(
    (span) => span.textContent,
  );

  expect(spans).toEqual(["ls", "python -c"]);

  render(html``, root);
});
