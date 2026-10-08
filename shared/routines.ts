import { z } from "zod";
import type { Routine, RoutineSchedule } from "./bot";

/** A run missed by more than this is skipped instead of caught up (OpenMausBot uses 12 hours). */
const CATCH_UP_MS = 12 * 60 * 60 * 1000;

function atLocalTime(day: Date, time: string): Date {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  const at = new Date(day);
  at.setHours(hours, minutes, 0, 0);
  return at;
}

type DailySchedule = Extract<RoutineSchedule, { kind: "daily" }>;

function latestCronDue(expression: string, since: Date, now: Date): Date | null {
  const cron = tryParseCron(expression);
  if (!cron) return null;
  const at = previousCronTime(cron, now, since);
  return at && at > since ? at : null;
}

function latestDailyDue(schedule: DailySchedule, since: Date, now: Date): Date | null {
  for (let back = 0; back <= 7; back++) {
    const day = new Date(now);
    day.setDate(now.getDate() - back);
    if (!schedule.weekdays.includes(day.getDay())) continue;
    const at = atLocalTime(day, schedule.time);
    if (at > now) continue;
    return at > since ? at : null;
  }
  return null;
}

function nextDailyRun(schedule: DailySchedule, now: Date): Date | null {
  if (schedule.weekdays.length === 0) return null;
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = new Date(now);
    day.setDate(now.getDate() + ahead);
    if (!schedule.weekdays.includes(day.getDay())) continue;
    const at = atLocalTime(day, schedule.time);
    if (at > now) return at;
  }
  return null;
}

/**
 * The most recent scheduled time at or before `now` that hasn't run yet, or
 * null. `since` is the last run (or the routine's creation when it never ran).
 */
export function latestDue(schedule: RoutineSchedule, since: Date, now: Date): Date | null {
  switch (schedule.kind) {
    case "webhook":
      return null;
    case "once": {
      const at = new Date(schedule.at);
      return at > since && at <= now ? at : null;
    }
    case "interval": {
      const due = new Date(since.getTime() + schedule.minutes * 60_000);
      return due <= now ? due : null;
    }
    case "cron":
      return latestCronDue(schedule.expression, since, now);
    case "daily":
      return latestDailyDue(schedule, since, now);
  }
}

/** The next time the routine will fire after `now`, for display. */
export function nextRun(schedule: RoutineSchedule, since: Date, now: Date): Date | null {
  switch (schedule.kind) {
    case "webhook":
      return null;
    case "once": {
      const at = new Date(schedule.at);
      return at > since && at > now ? at : null;
    }
    case "interval": {
      const due = new Date(since.getTime() + schedule.minutes * 60_000);
      return due > now ? due : now;
    }
    case "cron": {
      const cron = tryParseCron(schedule.expression);
      return cron ? nextCronTime(cron, now) : null;
    }
    case "daily":
      return nextDailyRun(schedule, now);
  }
}

/** The next `count` times the schedule fires after `now` (an interval that's already due starts with `now`). */
export function upcomingRuns(schedule: RoutineSchedule, since: Date, now: Date, count: number): Date[] {
  const runs: Date[] = [];
  let from = since;
  let after = now;
  while (runs.length < count) {
    const next = nextRun(schedule, from, after);
    const last = runs.at(-1);
    if (!next || (last && next <= last)) break;
    runs.push(next);
    from = next;
    after = next;
  }
  return runs;
}

/** "2026-09-27 09:00" in local time, the format the "At" field edits. */
export function formatLocalDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Reads "YYYY-MM-DD HH:MM" (or with a T) as local time; null when it isn't a real date. */
export function parseLocalDateTime(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(year, month - 1, day, hour, minute);
  const valid =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute;
  return valid ? date : null;
}

export type RoutineDecision =
  | { action: "run"; due: Date }
  | { action: "skip-missed"; due: Date }
  | { action: "wait" };

export function decide(routine: Routine, lastRunAt: string | null, now: Date): RoutineDecision {
  if (!routine.enabled) return { action: "wait" };
  const since = new Date(lastRunAt ?? routine.createdAt);
  const due = latestDue(routine.schedule, since, now);
  if (!due) return { action: "wait" };
  return now.getTime() - due.getTime() <= CATCH_UP_MS
    ? { action: "run", due }
    : { action: "skip-missed", due };
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case "webhook":
      return "When its webhook is called";
    case "cron":
      return describeCron(schedule.expression) ?? schedule.expression.trim();
    case "once":
      return `Once at ${new Date(schedule.at).toLocaleString()}`;
    case "interval":
      return schedule.minutes % 60 === 0
        ? `Every ${schedule.minutes / 60}h`
        : `Every ${schedule.minutes} min`;
    case "daily": {
      const days = [...schedule.weekdays].sort();
      const which =
        days.length === 7
          ? "Every day"
          : days.join(",") === "1,2,3,4,5"
            ? "Weekdays"
            : days.map((day) => WEEKDAY_NAMES[day]).join(", ");
      return `${which} at ${schedule.time}`;
    }
  }
}

// ---------------------------------------------------------------- cron

// Five-field cron with Paseo's grammar (protocol/schedule/cron-expression.ts):
// numbers, "*", ranges "a-b", steps "/n" and comma lists; every field must match
// (no day-of-month/day-of-week OR rule). Routines read it in the host's local time.

/** Paseo's schedule cadence presets (schedules/schedule-cadence-options.ts). */
export const CRON_PRESETS: readonly { id: string; label: string; expression: string }[] = [
  { id: "every-minute", label: "Every minute", expression: "* * * * *" },
  { id: "every-hour", label: "Every hour", expression: "0 * * * *" },
  { id: "daily-9", label: "Daily 9:00", expression: "0 9 * * *" },
  { id: "weekdays-9", label: "Weekdays 9:00", expression: "0 9 * * 1-5" },
  { id: "mondays-9", label: "Mondays 9:00", expression: "0 9 * * 1" },
];

export interface ParsedCron {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
}

const CRON_FIELDS = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day-of-week" },
] as const;

type CronBounds = (typeof CRON_FIELDS)[number];

function parseCronStep(stepSource: string | undefined, bounds: CronBounds): number {
  if (stepSource === undefined) return 1;
  const step = Number.parseInt(stepSource, 10);
  if (!Number.isInteger(step) || step <= 0 || String(step) !== stepSource.trim())
    throw new Error(`Invalid cron ${bounds.name} step`);
  return step;
}

function parseCronRange(base: string, bounds: CronBounds): [start: number, end: number] {
  if (base === "*") return [bounds.min, bounds.max];
  const range = /^(\d+)-(\d+)$/.exec(base);
  if (range) {
    const [, startText = "", endText = ""] = range;
    const start = Number.parseInt(startText, 10);
    const end = Number.parseInt(endText, 10);
    if (start > end || start < bounds.min || end > bounds.max)
      throw new Error(`Invalid cron ${bounds.name} range`);
    return [start, end];
  }
  if (!/^\d+$/.test(base)) throw new Error(`Invalid cron ${bounds.name} value`);
  const value = Number.parseInt(base, 10);
  if (value < bounds.min || value > bounds.max) throw new Error(`Invalid cron ${bounds.name} value`);
  return [value, value];
}

function parseCronField(source: string, bounds: CronBounds): Set<number> {
  const allowed = new Set<number>();
  for (const rawPart of source.split(",")) {
    const part = rawPart.trim();
    if (!part) throw new Error(`Invalid cron ${bounds.name} field`);
    const stepParts = part.split("/");
    if (stepParts.length > 2) throw new Error(`Invalid cron ${bounds.name} step`);
    const [base = "", stepSource] = stepParts;
    const step = parseCronStep(stepSource, bounds);
    const [start, end] = parseCronRange(base, bounds);
    for (let value = start; value <= end; value += step) allowed.add(value);
  }
  return allowed;
}

/** Throws with Paseo's messages ("Cron expressions must have 5 fields", "Invalid cron hour value", ...). */
function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron expressions must have 5 fields");
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = parts;
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = CRON_FIELDS;
  return {
    minute: parseCronField(minute, minuteField),
    hour: parseCronField(hour, hourField),
    dayOfMonth: parseCronField(dayOfMonth, dayOfMonthField),
    month: parseCronField(month, monthField),
    dayOfWeek: parseCronField(dayOfWeek, dayOfWeekField),
  };
}

function tryParseCron(expression: string): ParsedCron | null {
  try {
    return parseCron(expression);
  } catch {
    return null;
  }
}

/** Paseo's form validation copy (utils/schedule-format.ts validateCron); null when valid. */
export function validateCron(expression: string): string | null {
  const trimmed = expression.trim();
  if (!trimmed) return "Enter a cron expression";
  try {
    parseCron(trimmed);
    return null;
  } catch (error) {
    return (error instanceof Error ? error.message : "Invalid cron expression").replace(
      /^Invalid cron /,
      "Invalid ",
    );
  }
}

/** Far enough to reach a leap day. */
const CRON_SEARCH_DAYS = 4 * 366 + 1;

function sorted(values: ReadonlySet<number>, descending: boolean): number[] {
  return [...values].sort((a, b) => (descending ? b - a : a - b));
}

function dayMatches(cron: ParsedCron, day: Date): boolean {
  return (
    cron.month.has(day.getMonth() + 1) &&
    cron.dayOfMonth.has(day.getDate()) &&
    cron.dayOfWeek.has(day.getDay())
  );
}

function firstMatchOnDay(
  day: Date,
  times: { hours: readonly number[]; minutes: readonly number[] },
  accept: (at: Date) => boolean,
): Date | null {
  for (const hour of times.hours) {
    for (const minute of times.minutes) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
      if (accept(at)) return at;
    }
  }
  return null;
}

/** The first matching minute strictly after `after`, or null within four years. */
function nextCronTime(cron: ParsedCron, after: Date): Date | null {
  const times = { hours: sorted(cron.hour, false), minutes: sorted(cron.minute, false) };
  for (let offset = 0; offset <= CRON_SEARCH_DAYS; offset++) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset);
    if (!dayMatches(cron, day)) continue;
    const at = firstMatchOnDay(day, times, (candidate) => candidate > after);
    if (at) return at;
  }
  return null;
}

/** The latest matching minute at or before `atOrBefore`, searching back no further than `notBefore`'s day. */
function previousCronTime(cron: ParsedCron, atOrBefore: Date, notBefore: Date): Date | null {
  const times = { hours: sorted(cron.hour, true), minutes: sorted(cron.minute, true) };
  const span = Math.min(
    CRON_SEARCH_DAYS,
    Math.max(0, Math.ceil((atOrBefore.getTime() - notBefore.getTime()) / 86_400_000) + 1),
  );
  for (let offset = 0; offset <= span; offset++) {
    const day = new Date(atOrBefore.getFullYear(), atOrBefore.getMonth(), atOrBefore.getDate() - offset);
    if (!dayMatches(cron, day)) continue;
    const at = firstMatchOnDay(day, times, (candidate) => candidate <= atOrBefore);
    if (at) return at;
  }
  return null;
}

const CRON_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function describeMinuteCadence(minute: string, hour: string, dayOfWeek: string): string | null {
  if (hour !== "*" || dayOfWeek !== "*") return null;
  if (minute === "*") return "Every minute";
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  return everyMinutes ? `Every ${everyMinutes[1]} minutes` : null;
}

function describeHourCadence(hour: string, minuteNumber: number): string | null {
  const at = minuteNumber === 0 ? "" : ` at :${pad2(minuteNumber)}`;
  if (hour === "*") return `Every hour${at}`;
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  return everyHours ? `Every ${everyHours[1]} hours${at}` : null;
}

function cronDays(dayOfWeek: string): string | null {
  if (dayOfWeek === "*") return "Daily";
  if (dayOfWeek === "1-5") return "Weekdays";
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") return "Weekends";
  const name = /^\d$/.test(dayOfWeek) ? CRON_DAY_NAMES[Number.parseInt(dayOfWeek, 10)] : undefined;
  return name ? `${name}s` : null;
}

/**
 * Humanizes the common shapes like Paseo's describeCron (utils/schedule-format.ts),
 * minus the time zone: routines always run in the host's local time. Null for
 * valid expressions it can't phrase (callers show the expression).
 */
export function describeCron(expression: string): string | null {
  const trimmed = expression.trim();
  if (validateCron(trimmed) !== null) return null;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = trimmed.split(/\s+/);
  if (dayOfMonth !== "*" || month !== "*") return null;
  const minuteCadence = describeMinuteCadence(minute, hour, dayOfWeek);
  if (minuteCadence) return minuteCadence;
  if (!/^\d+$/.test(minute)) return null;
  const minuteNumber = Number.parseInt(minute, 10);
  const hourCadence = dayOfWeek === "*" ? describeHourCadence(hour, minuteNumber) : null;
  if (hourCadence) return hourCadence;
  if (!/^\d+$/.test(hour)) return null;
  const days = cronDays(dayOfWeek);
  return days ? `${days} at ${pad2(Number.parseInt(hour, 10))}:${pad2(minuteNumber)}` : null;
}

function dailyToCron(schedule: DailySchedule): string {
  const [hours = "9", minutes = "0"] = schedule.time.split(":");
  const days = [...new Set(schedule.weekdays)].sort((a, b) => a - b).join(",");
  const dow = days === "0,1,2,3,4,5,6" ? "*" : days === "1,2,3,4,5" ? "1-5" : days || "*";
  return `${Number(minutes)} ${Number(hours)} * * ${dow}`;
}

function intervalToCron(minutes: number): string {
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.round(minutes / 60);
  if (hours >= 24) return "0 9 * * *";
  return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
}

/**
 * The cron a routine's schedule reads as in the editor, like Paseo turning a
 * legacy interval into cron (normalizeScheduleFormCadence). Null for "once".
 */
export function scheduleToCron(schedule: RoutineSchedule): string | null {
  switch (schedule.kind) {
    case "cron":
      return schedule.expression;
    case "once":
    case "webhook":
      return null;
    case "daily":
      return dailyToCron(schedule);
    case "interval":
      return intervalToCron(schedule.minutes);
  }
}

// ---------------------------------------------------------------- tool input

/** A routine schedule as bots give it in tool calls. */
export const ScheduleInput = z.object({
  type: z.enum(["once", "daily", "cron", "interval", "webhook"]),
  at: z.string().max(40).optional().describe('For "once": local date and time, "YYYY-MM-DD HH:MM".'),
  time: z.string().max(5).optional().describe('For "daily": local time, "HH:MM".'),
  weekdays: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .optional()
    .describe('For "daily": the days to run, 0 = Sunday to 6 = Saturday. Every day when left out.'),
  expression: z
    .string()
    .max(100)
    .optional()
    .describe('For "cron": five fields (minute hour day-of-month month day-of-week) in local time.'),
  every_minutes: z
    .number()
    .int()
    .min(5)
    .max(1440)
    .optional()
    .describe('For "interval": minutes between runs, 5 to 1440.'),
});

type ScheduleArgs = z.infer<typeof ScheduleInput>;

function onceFrom(input: ScheduleArgs, now: Date): RoutineSchedule {
  const at = input.at ? (parseLocalDateTime(input.at) ?? new Date(input.at)) : null;
  if (!at || Number.isNaN(at.getTime()))
    throw new Error('A "once" routine needs "at" as "YYYY-MM-DD HH:MM".');
  if (at <= now) throw new Error(`${input.at} has already passed. Pick a time in the future.`);
  return { kind: "once", at: at.toISOString() };
}

function dailyFrom(input: ScheduleArgs): RoutineSchedule {
  if (!input.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time))
    throw new Error('A "daily" routine needs "time" as "HH:MM".');
  const weekdays = [...new Set(input.weekdays ?? [0, 1, 2, 3, 4, 5, 6])].sort();
  if (weekdays.length === 0) throw new Error("Give at least one weekday.");
  return { kind: "daily", time: input.time, weekdays };
}

function cronFrom(input: ScheduleArgs): RoutineSchedule {
  const expression = input.expression ?? "";
  const error = validateCron(expression);
  if (error) throw new Error(`${error}. Use five fields: minute hour day-of-month month day-of-week.`);
  return { kind: "cron", expression: expression.trim() };
}

/** The routine schedule a tool call describes; throws a message the bot can act on. */
export function scheduleFrom(input: ScheduleArgs, now: Date): RoutineSchedule {
  switch (input.type) {
    case "once":
      return onceFrom(input, now);
    case "daily":
      return dailyFrom(input);
    case "cron":
      return cronFrom(input);
    case "interval":
      if (!input.every_minutes) throw new Error('An "interval" routine needs "every_minutes" (5 to 1440).');
      return { kind: "interval", minutes: input.every_minutes };
    case "webhook":
      return { kind: "webhook" };
  }
}
