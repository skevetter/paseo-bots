import { calendarDaysBetween } from "../time";

/** Mirrors Paseo's formatDuration (utils/time.ts); always floors. */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0s";
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) return `${Math.floor(totalSeconds)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = Math.floor(totalSeconds) % 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

let timeFormatter: Intl.DateTimeFormat | null = null;

/** Mirrors Paseo's formatMessageTimestamp (utils/time.ts). */
export function formatMessageTimestamp(date: Date, now: Date = new Date()): string {
  if (!timeFormatter) {
    const resolved = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).resolvedOptions();
    timeFormatter = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hourCycle: resolved.hourCycle,
    });
  }
  const time = timeFormatter.format(date);
  const daysAgo = calendarDaysBetween(date, now);
  if (daysAgo === 0) return time;
  if (daysAgo > 0 && daysAgo < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}, ${time}`;
}
