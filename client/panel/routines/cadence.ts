import { useState } from "react";
import type { RoutineSchedule } from "../../../shared/bot";
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

function inAnHour(): Date {
  const at = new Date(Date.now() + 60 * 60_000);
  at.setSeconds(0, 0);
  return at;
}

function presetValueOf(schedule: RoutineSchedule, trimmedCron: string): string {
  if (schedule.kind === "once") return ONCE;
  if (schedule.kind === "webhook") return WEBHOOK;
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
  onceText: string;
  onceDate: Date | null;
  onceError: string | null;
  presetValue: string;
  choosePreset(value: string): void;
  editOnce(text: string): void;
  editCron(text: string): void;
}

export function useCadence(original: RoutineSchedule): Cadence {
  const [schedule, setSchedule] = useState<RoutineSchedule>(original);
  const [cronText, setCronText] = useState(() => scheduleToCron(original) ?? "0 9 * * *");
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
  const editCron = (text: string) => {
    setCronText(text);
    setSchedule({ kind: "cron", expression: text.trim() });
  };

  return {
    schedule,
    cronText,
    trimmedCron,
    cronKey,
    cronError: once || schedule.kind === "webhook" ? null : validateCron(trimmedCron),
    onceText,
    onceDate,
    onceError: onceErrorOf(schedule, original, onceDate),
    presetValue: presetValueOf(schedule, trimmedCron),
    choosePreset,
    editOnce,
    editCron,
  };
}
