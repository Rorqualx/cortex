// System-context nudge injected before autonomous turns when plan.mode === "prompt".
// Guidance only — the harness has no hard plan phase; this steers the model to plan
// and to run checks before committing (the quality gate is pre-commit; see plugin.ts).
export const PLAN_FIRST_GUIDANCE = [
  "Before acting on a non-trivial, multi-step task: briefly state a plan (the steps",
  "and the files you expect to touch) before making changes.",
  "When the task involves code, run the project's changed-file checks and fix failures",
  "BEFORE committing — a finalize-time quality gate cannot revise work once you have",
  "already committed or pushed.",
].join(" ");
