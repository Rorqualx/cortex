// Control UI module implements presenter behavior.
import { t } from "../i18n/index.ts";
import { resolveCronJobLastRunStatus } from "./cron-status.ts";
import {
  formatDateMs,
  formatRelativeTimestamp,
  formatDurationHuman,
  formatMs,
  formatUnknownText,
} from "./format.ts";
import type { CronJob, GatewaySessionRow, PresenceEntry } from "./types.ts";

export function formatPresenceAge(entry: PresenceEntry): string {
  const ts = entry.ts ?? null;
  return ts ? formatRelativeTimestamp(ts) : t("common.na");
}

export function formatNextRun(ms?: number | null) {
  if (!ms) {
    return t("common.na");
  }
  const weekday = formatDateMs(ms, { weekday: "short" });
  if (weekday === t("common.na")) {
    return weekday;
  }
  return `${weekday}, ${formatMs(ms)} (${formatRelativeTimestamp(ms)})`;
}

export function formatSessionTokens(row: GatewaySessionRow) {
  if (row.totalTokens == null) {
    return t("common.na");
  }
  const total = row.totalTokens ?? 0;
  const ctx = row.contextTokens ?? 0;
  return ctx ? `${total} / ${ctx}` : String(total);
}

export function formatEventPayload(payload: unknown): string {
  if (payload == null) {
    return "";
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return formatUnknownText(payload);
  }
}

export function formatCronState(job: CronJob) {
  const state = job.state ?? {};
  const status = resolveCronJobLastRunStatus(job);
  const parts = [status];
  if (state.nextRunAtMs) {
    parts.push(`next ${formatNextRun(state.nextRunAtMs)}`);
  }
  if (state.lastRunAtMs) {
    parts.push(`last ${formatNextRun(state.lastRunAtMs)}`);
  }
  return parts.join(" · ");
}

const CRON_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatClock(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${n}th`;
  }
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}

// Translate the common standard 5-field cron shapes (minute hour day-of-month
// month day-of-week) into plain English. Returns null for anything with ranges,
// steps on hour/day, or multi-field combinations we don't render cleanly, so the
// caller can fall back to the raw expression instead of lying about the schedule.
export function describeCronExpr(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }
  const [min, hour, dom, mon, dow] = parts;
  const wildcardRest = hour === "*" && dom === "*" && mon === "*" && dow === "*";

  const everyMinutes = /^\*\/(\d+)$/.exec(min);
  if (everyMinutes && wildcardRest) {
    const step = Number(everyMinutes[1]);
    return step === 1 ? "Every minute" : `Every ${step} minutes`;
  }
  if (/^\d+$/.test(min) && wildcardRest) {
    const minute = Number(min);
    return minute === 0 ? "Hourly" : `Hourly at :${String(minute).padStart(2, "0")}`;
  }

  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || mon !== "*") {
    return null;
  }
  const minute = Number(min);
  const hourValue = Number(hour);
  if (minute > 59 || hourValue > 23) {
    return null;
  }
  const at = formatClock(hourValue, minute);

  if (dom === "*" && dow === "*") {
    return `Daily at ${at}`;
  }
  if (dom === "*" && dow !== "*") {
    const days = dow.split(",").map((raw) => {
      const day = Number(raw);
      return /^\d+$/.test(raw) && day >= 0 && day <= 7 ? CRON_WEEKDAYS[day % 7] : null;
    });
    return days.every(Boolean) ? `Weekly on ${days.join(", ")} at ${at}` : null;
  }
  if (/^\d+$/.test(dom) && dow === "*") {
    return `Monthly on the ${ordinal(Number(dom))} at ${at}`;
  }
  return null;
}

export function formatCronSchedule(job: CronJob) {
  const s = job.schedule;
  if (s.kind === "at") {
    const atMs = Date.parse(s.at);
    return Number.isFinite(atMs) ? `At ${formatMs(atMs)}` : `At ${s.at}`;
  }
  if (s.kind === "every") {
    return `Every ${formatDurationHuman(s.everyMs)}`;
  }
  const human = describeCronExpr(s.expr);
  return `${human ?? `Cron ${s.expr}`}${s.tz ? ` (${s.tz})` : ""}`;
}

export function formatCronPayload(job: CronJob) {
  const p = job.payload;
  if (p.kind === "systemEvent") {
    return `System: ${p.text}`;
  }
  if (p.kind === "command") {
    return `Command: ${p.argv.join(" ")}`;
  }
  const base = `Agent: ${p.message}`;
  const delivery = job.delivery;
  if (delivery && delivery.mode !== "none") {
    const target =
      delivery.mode === "webhook"
        ? delivery.to
          ? ` (${delivery.to})`
          : ""
        : delivery.channel || delivery.to
          ? ` (${delivery.channel ?? "last"}${delivery.to ? ` -> ${delivery.to}` : ""})`
          : "";
    return `${base} · ${delivery.mode}${target}`;
  }
  return base;
}
