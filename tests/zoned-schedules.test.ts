import { describe, expect, it } from "vitest";
import type { RoutineSchedule } from "../shared/bot";
import { latestDue, nextRun, upcomingRuns } from "../shared/routines";
import { type SchedulePolicy, SchedulePolicySchema } from "../shared/schedule-policy";

const daily: RoutineSchedule = { kind: "daily", time: "02:30", weekdays: [0, 1, 2, 3, 4, 5, 6] };
const zone: SchedulePolicy = { version: 1, timeZone: "America/New_York", gap: "skip", repeat: "first" };
const at = (iso: string) => new Date(iso);

describe("explicit zoned schedules", () => {
  it("uses the selected quarter-hour-offset zone, not the machine's local zone", () => {
    const now = at("2026-01-01T02:00:00Z");
    const schedule = { ...daily, time: "09:00" };
    expect(nextRun(schedule, now, now, { ...zone, timeZone: "Asia/Kathmandu" })).toEqual(
      at("2026-01-01T03:15:00Z"),
    );
  });

  it("skips a spring gap or shifts it forward by the transition duration", () => {
    const before = at("2026-03-07T12:00:00Z");
    const now = at("2026-03-08T06:00:00Z");
    expect(nextRun(daily, before, now, zone)).toEqual(at("2026-03-09T06:30:00Z"));
    expect(nextRun(daily, before, now, { ...zone, gap: "shift_forward" })).toEqual(
      at("2026-03-08T07:30:00Z"),
    );
    expect(latestDue(daily, before, at("2026-03-08T08:00:00Z"), zone)).toBeNull();
    expect(latestDue(daily, before, at("2026-03-08T08:00:00Z"), { ...zone, gap: "shift_forward" })).toEqual(
      at("2026-03-08T07:30:00Z"),
    );
  });

  it("selects first, second or both instants in a repeated hour", () => {
    const schedule = { ...daily, time: "01:30" };
    const now = at("2026-11-01T05:00:00Z");
    expect(nextRun(schedule, now, now, zone)).toEqual(at("2026-11-01T05:30:00Z"));
    expect(nextRun(schedule, now, now, { ...zone, repeat: "second" })).toEqual(at("2026-11-01T06:30:00Z"));
    expect(upcomingRuns(schedule, now, now, { count: 2, policy: { ...zone, repeat: "both" } })).toEqual([
      at("2026-11-01T05:30:00Z"),
      at("2026-11-01T06:30:00Z"),
    ]);
    expect(nextRun(schedule, now, at("2026-11-01T05:31:00Z"), zone)).toEqual(at("2026-11-02T06:30:00Z"));
  });

  it("orders repeated cron minutes by actual instant rather than wall-clock order", () => {
    const now = at("2026-11-01T05:31:00Z");
    expect(nextRun({ kind: "cron", expression: "* 1 * * *" }, now, now, { ...zone, repeat: "both" })).toEqual(
      at("2026-11-01T05:32:00Z"),
    );
  });

  it("handles half-hour gaps without assuming a one-hour transition", () => {
    const now = at("2026-10-03T14:00:00Z");
    const schedule = { ...daily, time: "02:15" };
    const policy = { ...zone, timeZone: "Australia/Lord_Howe" };
    expect(nextRun(schedule, now, now, policy)).toEqual(at("2026-10-04T15:15:00Z"));
    expect(nextRun(schedule, now, now, { ...policy, gap: "shift_forward" })).toEqual(
      at("2026-10-03T15:45:00Z"),
    );
  });

  it("handles a skipped calendar date while keeping the scheduled weekday", () => {
    const now = at("2011-12-30T09:00:00Z");
    const schedule: RoutineSchedule = { kind: "daily", time: "12:00", weekdays: [5] };
    const policy = { ...zone, timeZone: "Pacific/Apia" };
    expect(nextRun(schedule, now, now, policy)).toEqual(at("2012-01-05T22:00:00Z"));
    expect(nextRun(schedule, now, now, { ...policy, gap: "shift_forward" })).toEqual(
      at("2011-12-30T22:00:00Z"),
    );
  });

  it("preserves cron day-of-month AND day-of-week matching in the selected zone", () => {
    const now = at("2026-01-01T00:00:00Z");
    expect(
      nextRun({ kind: "cron", expression: "0 9 13 * 1" }, now, now, { ...zone, timeZone: "UTC" }),
    ).toEqual(at("2026-04-13T09:00:00Z"));
  });

  it("keeps intervals elapsed across clock changes", () => {
    const since = at("2026-03-08T06:50:00Z");
    const now = at("2026-03-08T07:25:00Z");
    const schedule: RoutineSchedule = { kind: "interval", minutes: 30 };
    expect(latestDue(schedule, since, now, zone)).toEqual(at("2026-03-08T07:20:00Z"));
    expect(
      latestDue(schedule, since, now, {
        ...zone,
        timeZone: "Pacific/Apia",
        gap: "shift_forward",
        repeat: "both",
      }),
    ).toEqual(latestDue(schedule, since, now));
  });
});

describe("explicit schedule policy boundaries", () => {
  it("rejects unsupported zones and omitted discontinuity decisions", () => {
    expect(SchedulePolicySchema.safeParse({ ...zone, timeZone: "Not/AZone" }).success).toBe(false);
    expect(SchedulePolicySchema.safeParse({ version: 1, timeZone: "UTC" }).success).toBe(false);
  });
});
