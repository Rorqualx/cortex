// Control UI tests cover presenter formatting behavior.
import { describe, expect, it } from "vitest";
import { describeCronExpr, formatCronSchedule } from "./presenter.ts";
import type { CronJob } from "./types.ts";

describe("describeCronExpr", () => {
  it("humanizes daily schedules", () => {
    expect(describeCronExpr("0 0 * * *")).toBe("Daily at 12:00 AM");
    expect(describeCronExpr("0 3 * * *")).toBe("Daily at 3:00 AM");
    expect(describeCronExpr("30 14 * * *")).toBe("Daily at 2:30 PM");
  });

  it("humanizes minute and hourly steps", () => {
    expect(describeCronExpr("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCronExpr("*/1 * * * *")).toBe("Every minute");
    expect(describeCronExpr("0 * * * *")).toBe("Hourly");
    expect(describeCronExpr("15 * * * *")).toBe("Hourly at :15");
  });

  it("humanizes weekly and monthly schedules", () => {
    expect(describeCronExpr("0 9 * * 1")).toBe("Weekly on Mon at 9:00 AM");
    expect(describeCronExpr("0 9 * * 1,3,5")).toBe("Weekly on Mon, Wed, Fri at 9:00 AM");
    expect(describeCronExpr("0 0 1 * *")).toBe("Monthly on the 1st at 12:00 AM");
    expect(describeCronExpr("0 0 22 * *")).toBe("Monthly on the 22nd at 12:00 AM");
  });

  it("returns null for shapes it cannot render cleanly", () => {
    expect(describeCronExpr("0 0 1 1 *")).toBeNull(); // specific month
    expect(describeCronExpr("0 0 1-5 * *")).toBeNull(); // day-of-month range
    expect(describeCronExpr("0 0 * * 1-5")).toBeNull(); // weekday range
    expect(describeCronExpr("nonsense")).toBeNull();
  });
});

describe("formatCronSchedule", () => {
  const cronJob = (expr: string, tz?: string): CronJob =>
    ({ schedule: { kind: "cron", expr, ...(tz ? { tz } : {}) } }) as CronJob;

  it("uses the human description and appends the timezone", () => {
    expect(formatCronSchedule(cronJob("0 3 * * *", "America/Denver"))).toBe(
      "Daily at 3:00 AM (America/Denver)",
    );
  });

  it("falls back to the raw expression when it cannot be humanized", () => {
    expect(formatCronSchedule(cronJob("5 0 1 1 *"))).toBe("Cron 5 0 1 1 *");
  });
});
