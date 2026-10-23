import type { RpcInput } from "@getpaseo/plugin";
import { upcomingRuns, validateCron } from "../shared/routines";
import type { routinePreviewScheduleRpc } from "../shared/schedule-preview";

export function previewSchedule(input: RpcInput<typeof routinePreviewScheduleRpc>) {
  if (input.schedule.kind === "cron") {
    const error = validateCron(input.schedule.expression);
    if (error) throw new Error(error);
  }
  const policy = input.schedulePolicy;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: policy?.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  });
  const times = upcomingRuns(input.schedule, new Date(input.since), new Date(input.after), {
    count: input.count,
    policy: policy,
  });
  return {
    schedulePolicy: policy ?? null,
    legacyLocalTime:
      policy === undefined && (input.schedule.kind === "daily" || input.schedule.kind === "cron"),
    elapsed: input.schedule.kind === "interval",
    occurrences: times.map((time) => ({ at: time.toISOString(), localTime: formatter.format(time) })),
  };
}
