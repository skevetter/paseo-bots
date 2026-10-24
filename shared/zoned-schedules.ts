import type { RoutineSchedule } from "./bot";
import type { ParsedCron } from "./routines";
import type { SchedulePolicy } from "./schedule-policy";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SEARCH_DAYS = 4 * 366 + 1;
const DATE_LINE_MARGIN = 2;

type CalendarSchedule = Extract<RoutineSchedule, { kind: "cron" | "daily" }>;
interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}
interface Bounds {
  after: number;
  until: number;
}
export interface ZonedSchedule {
  schedule: CalendarSchedule;
  policy: SchedulePolicy;
  cron: ParsedCron | null;
}
interface SearchContext extends ZonedSchedule {
  formatter: Intl.DateTimeFormat;
  bounds: Bounds;
  direction: 1 | -1;
  minutes: number[];
}

function wallTime(formatter: Intl.DateTimeFormat, instant: number): WallTime {
  const fields: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant))
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  return {
    year: fields.year ?? 0,
    month: fields.month ?? 0,
    day: fields.day ?? 0,
    hour: fields.hour ?? 0,
    minute: fields.minute ?? 0,
    second: fields.second ?? 0,
  };
}

function wallEpoch(formatter: Intl.DateTimeFormat, instant: number): number {
  const wall = wallTime(formatter, instant);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

function dayOffsets(formatter: Intl.DateTimeFormat, day: number): Set<number> {
  const offsets = new Set<number>();
  // Sampling either side also finds half-hour transitions and a skipped calendar day.
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = day + hours * 3_600_000;
    offsets.add(wallEpoch(formatter, instant) - instant);
  }
  return offsets;
}

function repeatedInstants(matches: number[], repeat: SchedulePolicy["repeat"]): number[] {
  matches.sort((a, b) => a - b);
  switch (repeat) {
    case "first":
      return matches.slice(0, 1);
    case "second":
      return matches.slice(-1);
    case "both":
      return matches;
  }
}

function instantsAt(requested: number, offsets: ReadonlySet<number>, context: SearchContext): number[] {
  const matches: number[] = [];
  let shifted: number | null = null;
  let smallestShift = Number.POSITIVE_INFINITY;
  for (const offset of offsets) {
    const instant = requested - offset;
    const shift = wallEpoch(context.formatter, instant) - requested;
    if (shift === 0) matches.push(instant);
    if (shift > 0 && shift < smallestShift) {
      shifted = instant;
      smallestShift = shift;
    }
  }
  if (matches.length > 0) return repeatedInstants(matches, context.policy.repeat);
  if (context.policy.gap === "skip") return [];
  return shifted === null ? [] : [shifted];
}

function matchingDay(schedule: CalendarSchedule, day: Date, cron: ParsedCron | null): boolean {
  if (schedule.kind === "daily") return schedule.weekdays.includes(day.getUTCDay());
  return (
    !!cron &&
    cron.month.has(day.getUTCMonth() + 1) &&
    cron.dayOfMonth.has(day.getUTCDate()) &&
    cron.dayOfWeek.has(day.getUTCDay())
  );
}

function calendarMinutes(schedule: CalendarSchedule, cron: ParsedCron | null): number[] {
  if (schedule.kind === "daily") {
    const [hour = 0, minute = 0] = schedule.time.split(":").map(Number);
    return [hour * 60 + minute];
  }
  if (!cron) return [];
  const minutes: number[] = [];
  for (const hour of cron.hour) for (const minute of cron.minute) minutes.push(hour * 60 + minute);
  return minutes;
}

function fixedOffsetMatch(day: number, offset: number, context: SearchContext): number | null {
  let best = Number.POSITIVE_INFINITY;
  for (const minute of context.minutes) {
    const instant = day + minute * MINUTE_MS - offset;
    if (instant <= context.bounds.after || instant > context.bounds.until) continue;
    best = Math.min(best, context.direction * instant);
  }
  return Number.isFinite(best) ? best * context.direction : null;
}

function matchOnDay(day: number, context: SearchContext): number | null {
  const offsets = dayOffsets(context.formatter, day);
  const first = offsets.values().next().value;
  if (offsets.size === 1 && first !== undefined) return fixedOffsetMatch(day, first, context);
  let best = Number.POSITIVE_INFINITY;
  for (const minute of context.minutes) {
    for (const instant of instantsAt(day + minute * MINUTE_MS, offsets, context)) {
      if (instant <= context.bounds.after || instant > context.bounds.until) continue;
      best = Math.min(best, context.direction * instant);
    }
  }
  return Number.isFinite(best) ? best * context.direction : null;
}

function searchContext(spec: ZonedSchedule, bounds: Bounds, direction: 1 | -1): SearchContext {
  return {
    ...spec,
    bounds,
    direction,
    minutes: calendarMinutes(spec.schedule, spec.cron),
    formatter: new Intl.DateTimeFormat("en-GB", {
      timeZone: spec.policy.timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  };
}

function search(spec: ZonedSchedule, bounds: Bounds, pivot: Date, direction: 1 | -1): Date | null {
  const context = searchContext(spec, bounds, direction);
  if (context.minutes.length === 0) return null;
  const wall = wallTime(context.formatter, pivot.getTime());
  const base = Date.UTC(wall.year, wall.month - 1, wall.day);
  const span =
    direction === 1
      ? SEARCH_DAYS
      : Math.min(SEARCH_DAYS, Math.ceil((bounds.until - bounds.after) / DAY_MS) + 1);
  let best = Number.POSITIVE_INFINITY;
  let settled = Number.POSITIVE_INFINITY;
  // Date-line changes can shift a scheduled wall date into its neighbour's actual day.
  for (let step = 0; step <= span + DATE_LINE_MARGIN * 2 && step <= settled; step++) {
    const day = base + direction * (step - DATE_LINE_MARGIN) * DAY_MS;
    if (!matchingDay(spec.schedule, new Date(day), spec.cron)) continue;
    const candidate = matchOnDay(day, context);
    if (candidate === null) continue;
    best = Math.min(best, direction * candidate);
    settled = Math.min(settled, step + DATE_LINE_MARGIN * 2);
  }
  return Number.isFinite(best) ? new Date(direction * best) : null;
}

export function nextZonedRun(spec: ZonedSchedule, now: Date): Date | null {
  return search(spec, { after: now.getTime(), until: Number.POSITIVE_INFINITY }, now, 1);
}

export function latestZonedDue(spec: ZonedSchedule, since: Date, now: Date): Date | null {
  return search(spec, { after: since.getTime(), until: now.getTime() }, now, -1);
}
