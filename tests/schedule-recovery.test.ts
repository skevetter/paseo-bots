import { describe, expect, it } from "vitest";
import type { Routine, RoutineSchedule } from "../shared/bot";
import { nextRun } from "../shared/routines";
import { type CatchUp, newSchedulePolicy, type SchedulePolicy } from "../shared/schedule-policy";
import { planOccurrences, scheduleNotBefore } from "../shared/schedule-recovery";

const at = (iso: string) => new Date(iso);
const CREATED = "2026-01-01T00:00:00.000Z";
const hourly: RoutineSchedule = { kind: "interval", minutes: 60 };

function routine(schedule: RoutineSchedule, policy?: SchedulePolicy, enabled = true): Routine {
  return {
    id: "routine-1",
    name: "Routine",
    prompt: "Run",
    enabled,
    schedule,
    schedulePolicy: policy,
    resultsChatId: null,
    createdAt: CREATED,
  };
}

function policy(catchUp: CatchUp, extra: Partial<SchedulePolicy> = {}): SchedulePolicy {
  return { ...newSchedulePolicy("UTC"), catchUp, ...extra };
}

const coalesce2h: CatchUp = { windowSeconds: 7200, maxOccurrences: 1, strategy: "coalesce" };

describe("interval recovery", () => {
  // Occurrences at 01:00, 02:00, 03:00, 04:00, 05:00; now is 05:30.
  const now = at("2026-01-01T05:30:00Z");

  it("coalesces in-window backlog into one run and reports the outage separately", () => {
    const plan = planOccurrences(routine(hourly, policy(coalesce2h)), null, now);
    expect(plan.runs).toEqual([at("2026-01-01T05:00:00Z")]);
    expect(plan.plannedThrough).toEqual(at("2026-01-01T05:00:00Z"));
    expect(plan.summaries).toEqual([
      {
        due: at("2026-01-01T03:00:00Z"),
        reason: "outside_window",
        count: 3,
        firstDue: at("2026-01-01T01:00:00Z"),
        through: at("2026-01-01T05:00:00Z"),
      },
      {
        due: at("2026-01-01T04:00:00Z"),
        reason: "coalesced",
        count: 1,
        firstDue: at("2026-01-01T04:00:00Z"),
        through: at("2026-01-01T05:00:00Z"),
        into: at("2026-01-01T05:00:00Z"),
      },
    ]);
  });

  it("queues up to maxOccurrences, oldest suppressed reported as recovery_limit", () => {
    const queue = policy({ windowSeconds: 86_400, maxOccurrences: 2, strategy: "queue" });
    const plan = planOccurrences(routine(hourly, queue), null, now);
    expect(plan.runs).toEqual([at("2026-01-01T04:00:00Z"), at("2026-01-01T05:00:00Z")]);
    expect(plan.summaries).toEqual([
      {
        due: at("2026-01-01T03:00:00Z"),
        reason: "recovery_limit",
        count: 3,
        firstDue: at("2026-01-01T01:00:00Z"),
        through: at("2026-01-01T05:00:00Z"),
      },
    ]);
  });

  it("keeps the 90-minute phase from createdAt and plans whole elapsed steps", () => {
    const ninety: RoutineSchedule = { kind: "interval", minutes: 90 };
    const plan = planOccurrences(routine(ninety, policy(coalesce2h)), null, at("2026-01-01T04:00:00Z"));
    expect(plan.runs).toEqual([at("2026-01-01T03:00:00Z")]);
    expect(plan.plannedThrough).toEqual(at("2026-01-01T03:00:00Z"));
    expect(nextRun(ninety, at(CREATED), at("2026-01-01T04:00:00Z"), policy(coalesce2h))).toEqual(
      at("2026-01-01T04:30:00Z"),
    );
  });

  it("does not respawn after the planned boundary is passed back as lastRunAt", () => {
    const first = planOccurrences(routine(hourly, policy(coalesce2h)), null, now);
    const again = planOccurrences(
      routine(hourly, policy(coalesce2h)),
      first.plannedThrough?.toISOString() ?? null,
      now,
    );
    expect(again).toEqual({ runs: [], summaries: [], plannedThrough: null });
  });

  it("returns an empty plan for disabled routines", () => {
    expect(planOccurrences(routine(hourly, policy(coalesce2h), false), null, now)).toEqual({
      runs: [],
      summaries: [],
      plannedThrough: null,
    });
  });
});

describe("calendar recovery across DST", () => {
  const dailyAt = (time: string): RoutineSchedule => ({
    kind: "daily",
    time,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  const ny = (extra: Partial<SchedulePolicy>, catchUp: CatchUp): SchedulePolicy => ({
    ...newSchedulePolicy("America/New_York"),
    catchUp,
    ...extra,
  });
  const dayWindow: CatchUp = { windowSeconds: 86_400, maxOccurrences: 1, strategy: "coalesce" };

  it("repeat both coalesces the two instants of the repeated 01:30 hour", () => {
    const plan = planOccurrences(
      routine(dailyAt("01:30"), ny({ repeat: "both" }, dayWindow)),
      at("2026-10-31T12:00:00Z").toISOString(),
      at("2026-11-01T07:00:00Z"),
    );
    expect(plan.runs).toEqual([at("2026-11-01T06:30:00Z")]);
    expect(plan.summaries).toEqual([
      {
        due: at("2026-11-01T05:30:00Z"),
        reason: "coalesced",
        count: 1,
        firstDue: at("2026-11-01T05:30:00Z"),
        through: at("2026-11-01T06:30:00Z"),
        into: at("2026-11-01T06:30:00Z"),
      },
    ]);
  });

  it("repeat first selects only the first instant of the repeated hour", () => {
    const plan = planOccurrences(
      routine(dailyAt("01:30"), ny({ repeat: "first" }, dayWindow)),
      at("2026-10-31T12:00:00Z").toISOString(),
      at("2026-11-01T07:00:00Z"),
    );
    expect(plan.runs).toEqual([at("2026-11-01T05:30:00Z")]);
    expect(plan.summaries).toEqual([]);
  });

  it("skips a nonexistent spring-gap occurrence, or shifts it forward when configured", () => {
    const since = at("2026-03-07T12:00:00Z").toISOString();
    const now = at("2026-03-08T12:00:00Z");
    expect(planOccurrences(routine(dailyAt("02:30"), ny({ gap: "skip" }, dayWindow)), since, now)).toEqual({
      runs: [],
      summaries: [],
      plannedThrough: null,
    });
    expect(
      planOccurrences(routine(dailyAt("02:30"), ny({ gap: "shift_forward" }, dayWindow)), since, now).runs,
    ).toEqual([at("2026-03-08T07:30:00Z")]);
  });

  it("requires cron day-of-month AND day-of-week, not OR", () => {
    // Cron "0 9 1 * 1": 09:00 on the 1st only when that day is a Monday.
    // 2026-06-01 is the only such day from January to June 2026.
    const cron: RoutineSchedule = { kind: "cron", expression: "0 9 1 * 1" };
    const utc = {
      ...newSchedulePolicy("UTC"),
      catchUp: { windowSeconds: 604_800, maxOccurrences: 1, strategy: "coalesce" as const },
    };
    const plan = planOccurrences(
      routine(cron, utc),
      at("2026-01-01T00:00:00Z").toISOString(),
      at("2026-06-01T10:00:00Z"),
    );
    expect(plan.runs).toEqual([at("2026-06-01T09:00:00Z")]);
    expect(plan.summaries).toEqual([]);
  });
});

describe("legacy routines without schedulePolicy", () => {
  it("runs a recent due occurrence and skips one older than the 12-hour window", () => {
    const recent = planOccurrences(routine(hourly), null, at("2026-01-01T01:30:00Z"));
    expect(recent).toEqual({
      runs: [at("2026-01-01T01:00:00Z")],
      summaries: [],
      plannedThrough: at("2026-01-01T01:00:00Z"),
    });

    const stale = planOccurrences(routine(hourly), null, at("2026-01-02T01:00:00Z"));
    expect(stale).toEqual({
      runs: [],
      summaries: [
        {
          due: at("2026-01-01T01:00:00Z"),
          reason: "outside_window",
          count: null,
          firstDue: null,
          through: at("2026-01-01T01:00:00Z"),
        },
      ],
      plannedThrough: at("2026-01-01T01:00:00Z"),
    });
  });
});

describe("scheduleNotBefore jitter", () => {
  const due = at("2026-01-01T05:00:00Z");

  it("returns the due instant when no jitter tolerance is set", () => {
    expect(scheduleNotBefore(routine(hourly, policy(coalesce2h)), due)).toBe(due.getTime());
    expect(scheduleNotBefore(routine(hourly), due)).toBe(due.getTime());
  });

  it("stays within tolerance and is stable for the same routine and occurrence", () => {
    const jittered = routine(hourly, policy(coalesce2h, { jitterToleranceSeconds: 60 }));
    const first = scheduleNotBefore(jittered, due);
    expect(first).toBeGreaterThanOrEqual(due.getTime());
    expect(first).toBeLessThanOrEqual(due.getTime() + 60_000);
    expect(scheduleNotBefore(jittered, due)).toBe(first);
  });
});
