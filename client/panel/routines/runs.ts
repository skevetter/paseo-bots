import type { Routine } from "../../../shared/bot";
import { upcomingRuns } from "../../../shared/routines";
import type { RoutineRecord, RoutineRun } from "../../../shared/rpc";
import { calendarDaysBetween } from "../../../shared/time";
import type { BadgeVariant } from "../status";

const UPCOMING = 6;
export const UPCOMING_DAYS = 7;
const RECENT = 10;
const RUN_LABELS: Record<RoutineRun["status"], string> = {
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  "skipped-busy": "Skipped, still working",
  "skipped-missed": "Missed",
};
const TRIGGER_LABELS: Record<RoutineRun["trigger"], string> = {
  schedule: "on schedule",
  manual: "run by you",
  webhook: "from its webhook",
};

export function runTime(at: Date, now: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const offset = calendarDaysBetween(now, at);
  if (offset === 0) return `Today ${time}`;
  if (offset === 1) return `Tomorrow ${time}`;
  if (offset === -1) return `Yesterday ${time}`;
  return `${at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

export type UpcomingRun = { at: Date; routine: Routine };
export type RecentRun = { run: RoutineRun; routine: Routine };
type RecordOf = (routine: Routine) => RoutineRecord | undefined;

export function upcomingRunsOf(routines: Routine[], recordOf: RecordOf, now: Date): UpcomingRun[] {
  return routines
    .filter((routine) => routine.enabled)
    .flatMap((routine) =>
      upcomingRuns(
        routine.schedule,
        new Date(recordOf(routine)?.lastRunAt ?? routine.createdAt),
        now,
        UPCOMING,
      ).map((at) => ({ at, routine })),
    )
    .filter(({ at }) => at.getTime() - now.getTime() <= UPCOMING_DAYS * 86_400_000)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, UPCOMING);
}

export function recentRunsOf(routines: Routine[], recordOf: RecordOf): RecentRun[] {
  return routines
    .flatMap((routine) => (recordOf(routine)?.runs ?? []).map((entry) => ({ run: entry, routine })))
    .sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt))
    .slice(0, RECENT);
}

export function runsSummary(upcoming: UpcomingRun[], recent: RecentRun[], now: Date): string {
  const [nextUp] = upcoming;
  const [latest] = recent;
  return (
    [
      nextUp ? `Next ${runTime(nextUp.at, now)}` : null,
      latest ? `last ${runTime(new Date(latest.run.startedAt), now)}` : null,
    ]
      .filter(Boolean)
      .join(", ") || "None yet"
  );
}

export function runHint(entry: RoutineRun, now: Date): string {
  return [
    `${runTime(new Date(entry.startedAt), now)} · ${RUN_LABELS[entry.status]} · ${TRIGGER_LABELS[entry.trigger]}`,
    entry.error ?? entry.output,
  ]
    .filter(Boolean)
    .join("\n");
}

/** A Run now the user asked for: shown while the call is out, and a failure until the routine runs again. */
export type RunStart = { status: "starting" } | { status: "failed"; error: string; lastRunId: string | null };
export type RunStarts = Readonly<Record<string, RunStart>>;

export function withRunStart(starts: RunStarts, id: string, start: RunStart | null): RunStarts {
  const { [id]: _previous, ...rest } = starts;
  return start ? { ...rest, [id]: start } : rest;
}

export function routineState(
  routine: Routine,
  next: Date | null,
  start: RunStart | undefined,
): { label: string; variant: BadgeVariant } {
  if (start?.status === "starting") return { label: "Starting...", variant: "muted" };
  if (!routine.enabled) return { label: "Paused", variant: "muted" };
  // A webhook routine has no next time but stays ready to run.
  if (!next && routine.schedule.kind !== "webhook") return { label: "Finished", variant: "muted" };
  return { label: "Active", variant: "success" };
}

export function runStartError(start: RunStart | undefined, lastRun: RoutineRun | undefined): string | null {
  if (start?.status !== "failed" || (lastRun?.id ?? null) !== start.lastRunId) return null;
  return `Couldn't start the run: ${start.error}`;
}
