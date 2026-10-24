import { useState } from "react";
import { type RoutineSchedule, RoutineScheduleSchema } from "../../../shared/bot";
import {
  CRON_PRESETS,
  formatLocalDateTime,
  parseLocalDateTime,
  scheduleToCron,
  validateCron,
} from "../../../shared/routines";

const CUSTOM_CRON = "Custom cron";
export const ONCE = "once";
export const WEBHOOK = "webhook";
export const INTERVAL = "interval";
const DEFAULT_INTERVAL_MINUTES = 60;
const INTERVAL_ERROR = "Enter whole minutes from 5 to 1440";

/** Whole minutes the routine schema accepts; anything else is null, never rounded. */
function intervalMinutesOf(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  return RoutineScheduleSchema.safeParse({ kind: "interval", minutes }).success ? minutes : null;
}

function intervalErrorOf(schedule: RoutineSchedule, text: string): string | null {
  if (schedule.kind !== "interval") return null;
  return intervalMinutesOf(text) === null ? INTERVAL_ERROR : null;
}

function inAnHour(): Date {
  const at = new Date(Date.now() + 60 * 60_000);
  at.setSeconds(0, 0);
  return at;
}

function presetValueOf(schedule: RoutineSchedule, trimmedCron: string): string {
  if (schedule.kind === "once") return ONCE;
  if (schedule.kind === "webhook") return WEBHOOK;
  if (schedule.kind === "interval") return INTERVAL;
  return CRON_PRESETS.find((preset) => preset.expression === trimmedCron)?.id ?? CUSTOM_CRON;
}

function onceErrorOf(
  schedule: RoutineSchedule,
  original: RoutineSchedule,
  onceDate: Date | null,
): string | null {
  if (schedule.kind !== "once") return null;
  if (!onceDate) return "Use YYYY-MM-DD HH:MM";
  const onceChanged = original.kind !== "once" || onceDate.getTime() !== new Date(original.at).getTime();
  return onceChanged && onceDate.getTime() <= Date.now() ? "Pick a time in the future" : null;
}

export interface Cadence {
  schedule: RoutineSchedule;
  cronText: string;
  trimmedCron: string;
  cronKey: number;
  cronError: string | null;
  intervalText: string;
  intervalError: string | null;
  onceText: string;
  onceDate: Date | null;
  onceError: string | null;
  presetValue: string;
  choosePreset(value: string): void;
  editOnce(text: string): void;
  editInterval(text: string): void;
  editCron(text: string): void;
}

export function useCadence(original: RoutineSchedule): Cadence {
  const [schedule, setSchedule] = useState<RoutineSchedule>(original);
  const [cronText, setCronText] = useState(() => scheduleToCron(original) ?? "0 9 * * *");
  const [intervalText, setIntervalText] = useState(() =>
    String(original.kind === "interval" ? original.minutes : DEFAULT_INTERVAL_MINUTES),
  );
  const [onceText, setOnceText] = useState(() =>
    formatLocalDateTime(original.kind === "once" ? new Date(original.at) : inAnHour()),
  );
  // Presets rewrite the cron field; remounting resets it.
  const [cronKey, setCronKey] = useState(0);

  const once = schedule.kind === "once";
  const trimmedCron = cronText.trim();
  const onceDate = once ? parseLocalDateTime(onceText) : null;

  const choosePreset = (value: string) => {
    if (value === ONCE) {
      setSchedule({
        kind: "once",
        at: (parseLocalDateTime(onceText) ?? inAnHour()).toISOString(),
      });
      return;
    }
    if (value === WEBHOOK) {
      setSchedule({ kind: "webhook" });
      return;
    }
    if (value === INTERVAL) {
      setSchedule({ kind: "interval", minutes: intervalMinutesOf(intervalText) ?? DEFAULT_INTERVAL_MINUTES });
      return;
    }
    const preset = CRON_PRESETS.find((entry) => entry.id === value);
    if (!preset) return;
    setCronText(preset.expression);
    setCronKey((key) => key + 1);
    setSchedule({ kind: "cron", expression: preset.expression });
  };
  const editOnce = (text: string) => {
    setOnceText(text);
    const at = parseLocalDateTime(text);
    if (at) setSchedule({ kind: "once", at: at.toISOString() });
  };
  const editInterval = (text: string) => {
    setIntervalText(text);
    const minutes = intervalMinutesOf(text);
    if (minutes !== null) setSchedule({ kind: "interval", minutes });
  };
  const editCron = (text: string) => {
    setCronText(text);
    setSchedule({ kind: "cron", expression: text.trim() });
  };

  return {
    schedule,
    cronText,
    trimmedCron,
    cronKey,
    cronError:
      once || schedule.kind === "webhook" || schedule.kind === "interval" ? null : validateCron(trimmedCron),
    intervalText,
    intervalError: intervalErrorOf(schedule, intervalText),
    onceText,
    onceDate,
    onceError: onceErrorOf(schedule, original, onceDate),
    presetValue: presetValueOf(schedule, trimmedCron),
    choosePreset,
    editOnce,
    editInterval,
    editCron,
  };
}
