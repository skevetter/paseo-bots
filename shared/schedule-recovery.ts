import type { Routine, RoutineSchedule } from "./bot";
import { decide, tryParseCron } from "./routines";
import { type CatchUp, recoveryOf, type SchedulePolicy } from "./schedule-policy";
import { latestZonedDue, nextZonedRun, type ZonedSchedule } from "./zoned-schedules";

const MINUTE_MS = 60_000;
/** One past the largest recoverable backlog, so "over limit" is distinguishable from "exact". */
const SCAN_LIMIT = 101;
/** Calendar counts past this many occurrences are reported as unknown, never estimated. */
const COUNT_LIMIT = 400;

export interface RecoverySummary {
  /** Latest suppressed intended occurrence; never also a selected run. */
  due: Date;
  reason: "outside_window" | "recovery_limit" | "coalesced";
  /** Suppressed occurrences in this bucket, or null when not countable. */
  count: number | null;
  /** Earliest occurrence in this bucket. */
  firstDue: Date | null;
  /** Latest intended occurrence the plan has handled; the next plan starts after it. */
  through: Date;
  /** Selected run that absorbed the suppressed occurrences (coalesced only). */
  into?: Date;
}

export interface ScheduleRecoveryPlan {
  /** Chronological, at most the policy's maxOccurrences (and never more than 100). */
  runs: Date[];
  /** At most two: one outside_window bucket and one in-window bucket. */
  summaries: RecoverySummary[];
  /** Latest intended occurrence at or before now; null when none fell due. */
  plannedThrough: Date | null;
}

/**
 * Occurrences strictly after `since` and at or before `now`, in epoch ms.
 * `countBefore`/`latestBefore`/`earliestFrom` take exclusive bounds and return null when unknown.
 */
interface Series {
  latest(limit: number): number[];
  countBefore(at: number): number | null;
  latestBefore(at: number): number | null;
  earliestFrom(at: number): number | null;
}

function intervalSeries(minutes: number, since: number, now: number): Series {
  const step = minutes * MINUTE_MS;
  const total = Math.max(0, Math.floor((now - since) / step));
  const occurrence = (k: number) => since + k * step;
  const countBefore = (at: number) => Math.min(total, Math.max(0, Math.ceil((at - since) / step) - 1));
  return {
    latest(limit) {
      const out: number[] = [];
      for (let k = total; k >= 1 && out.length < limit; k--) out.push(occurrence(k));
      return out;
    },
    countBefore,
    latestBefore(at) {
      const count = countBefore(at);
      return count > 0 ? occurrence(count) : null;
    },
    earliestFrom(at) {
      const k = countBefore(at) + 1;
      return k <= total ? occurrence(k) : null;
    },
  };
}

function onceSeries(at: number, since: number, now: number): Series {
  const inRange = at > since && at <= now;
  const countBefore = (before: number) => (inRange && at < before ? 1 : 0);
  return {
    latest: () => (inRange ? [at] : []),
    countBefore,
    latestBefore: (before) => (countBefore(before) > 0 ? at : null),
    earliestFrom: (from) => (inRange && at >= from ? at : null),
  };
}

function calendarSeries(spec: ZonedSchedule, since: number, now: number): Series {
  const sinceDate = new Date(since);
  // Latest occurrence in (since, min(at, now)].
  const latestAtOrBefore = (at: number): number | null => {
    const due = latestZonedDue(spec, sinceDate, new Date(Math.min(at, now)));
    return due ? due.getTime() : null;
  };
  return {
    latest(limit) {
      const out: number[] = [];
      let cursor = now;
      while (out.length < limit) {
        const due = latestAtOrBefore(cursor);
        if (due === null) break;
        out.push(due);
        cursor = due - 1;
      }
      return out;
    },
    countBefore(at) {
      let cursor = Math.min(at - 1, now);
      for (let count = 0; ; count++) {
        const due = latestAtOrBefore(cursor);
        if (due === null) return count;
        if (count === COUNT_LIMIT) return null;
        cursor = due - 1;
      }
    },
    latestBefore: (at) => latestAtOrBefore(at - 1),
    earliestFrom(at) {
      const next = nextZonedRun(spec, new Date(Math.max(at, since + 1) - 1));
      return next && next.getTime() >= at && next.getTime() <= now ? next.getTime() : null;
    },
  };
}

function seriesFor(
  schedule: RoutineSchedule,
  since: number,
  now: number,
  policy: SchedulePolicy,
): Series | null {
  switch (schedule.kind) {
    case "webhook":
      return null;
    case "once":
      return onceSeries(new Date(schedule.at).getTime(), since, now);
    case "interval":
      return intervalSeries(schedule.minutes, since, now);
    case "cron": {
      const cron = tryParseCron(schedule.expression);
      return cron ? calendarSeries({ schedule, policy, cron }, since, now) : null;
    }
    case "daily":
      return calendarSeries({ schedule, policy, cron: null }, since, now);
  }
}

const none = (): ScheduleRecoveryPlan => ({ runs: [], summaries: [], plannedThrough: null });

/**
 * Plans the intended occurrences due since `lastRunAt` (or `createdAt`).
 * Routines without a schedulePolicy keep the legacy `decide` behaviour.
 */
export function planOccurrences(routine: Routine, lastRunAt: string | null, now: Date): ScheduleRecoveryPlan {
  if (!routine.enabled) return none();
  const policy = routine.schedulePolicy;
  return policy ? planWithPolicy(routine, policy, lastRunAt, now) : planLegacy(routine, lastRunAt, now);
}

function planLegacy(routine: Routine, lastRunAt: string | null, now: Date): ScheduleRecoveryPlan {
  const decision = decide(routine, lastRunAt, now);
  if (decision.action === "wait") return none();
  if (decision.action === "run") return { runs: [decision.due], summaries: [], plannedThrough: decision.due };
  return {
    runs: [],
    summaries: [
      { due: decision.due, reason: "outside_window", count: null, firstDue: null, through: decision.due },
    ],
    plannedThrough: decision.due,
  };
}

function planWithPolicy(
  routine: Routine,
  policy: SchedulePolicy,
  lastRunAt: string | null,
  now: Date,
): ScheduleRecoveryPlan {
  const sinceMs = new Date(lastRunAt ?? routine.createdAt).getTime();
  const nowMs = now.getTime();
  const series = seriesFor(routine.schedule, sinceMs, nowMs, policy);
  if (!series) return none();
  const items = series.latest(SCAN_LIMIT);
  const latest = items[0];
  if (latest === undefined) return none();

  const { catchUp } = recoveryOf(policy);
  const plannedThrough = new Date(latest);
  const windowStart = nowMs - catchUp.windowSeconds * 1000;
  const inWindow = items.filter((time) => time >= windowStart);
  const selected = selectCount(catchUp, inWindow.length);
  const runs = inWindow
    .slice(0, selected)
    .reverse()
    .map((time) => new Date(time));
  const olderCount = series.countBefore(windowStart);
  const summaries = [
    ...outsideSummary(series, { windowStart, sinceMs, olderCount, through: plannedThrough }),
    ...inWindowSummary(series, {
      catchUp,
      inWindow,
      selected,
      runs,
      olderCount,
      nowMs,
      windowStart,
      through: plannedThrough,
    }),
  ];
  return { runs, summaries, plannedThrough };
}

function selectCount(catchUp: CatchUp, available: number): number {
  return catchUp.strategy === "queue" ? Math.min(catchUp.maxOccurrences, available) : Math.min(1, available);
}

function outsideSummary(
  series: Series,
  args: { windowStart: number; sinceMs: number; olderCount: number | null; through: Date },
): RecoverySummary[] {
  const due = series.latestBefore(args.windowStart);
  if (due === null) return [];
  const firstDue = series.earliestFrom(args.sinceMs + 1);
  return [
    {
      due: new Date(due),
      reason: "outside_window",
      count: args.olderCount,
      firstDue: firstDue === null ? null : new Date(firstDue),
      through: args.through,
    },
  ];
}

function inWindowSummary(
  series: Series,
  args: {
    catchUp: CatchUp;
    inWindow: number[];
    selected: number;
    runs: Date[];
    olderCount: number | null;
    nowMs: number;
    windowStart: number;
    through: Date;
  },
): RecoverySummary[] {
  const { catchUp, inWindow, selected, runs, olderCount, nowMs, windowStart, through } = args;
  const suppressed = inWindow[selected];
  if (suppressed === undefined) return [];
  const total = series.countBefore(nowMs + 1);
  const firstDue = series.earliestFrom(windowStart);
  const base = {
    due: new Date(suppressed),
    count: total !== null && olderCount !== null ? total - olderCount - selected : null,
    firstDue: firstDue === null ? null : new Date(firstDue),
    through,
  };
  return [
    catchUp.strategy === "coalesce"
      ? { ...base, reason: "coalesced", into: runs[runs.length - 1] as Date }
      : { ...base, reason: "recovery_limit" },
  ];
}

/**
 * Deterministic start offset for a due occurrence, within the routine's jitter tolerance.
 * The same routine and occurrence always map to the same instant, so restarts don't drift.
 */
export function scheduleNotBefore(routine: Routine, due: Date): number {
  const tolerance = routine.schedulePolicy ? recoveryOf(routine.schedulePolicy).jitterToleranceSeconds : 0;
  const dueMs = due.getTime();
  if (tolerance === 0) return dueMs;
  return dueMs + (fnv1a(`${routine.id}:${dueMs}`) % (tolerance * 1000 + 1));
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
