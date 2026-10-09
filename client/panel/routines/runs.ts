import type { Routine } from "../../../shared/bot";
import { upcomingRuns } from "../../../shared/routines";
import type { RoutineRecord, RoutineRun } from "../../../shared/rpc";

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
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const offset = Math.round((day - today) / 86_400_000);
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
