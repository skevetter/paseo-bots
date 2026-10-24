import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { RoutineScheduleSchema } from "./bot";
import { SchedulePolicySchema } from "./schedule-policy";

export const routinePreviewScheduleRpc = defineRpc({
  name: "bots.routines.preview-schedule",
  input: z.object({
    schedule: RoutineScheduleSchema,
    schedulePolicy: SchedulePolicySchema.optional(),
    since: z.iso.datetime(),
    after: z.iso.datetime(),
    count: z.number().int().min(1).max(50).default(5),
  }),
  output: z.object({
    schedulePolicy: SchedulePolicySchema.nullable(),
    legacyLocalTime: z.boolean(),
    elapsed: z.boolean(),
    occurrences: z.array(z.object({ at: z.iso.datetime(), localTime: z.string() })),
  }),
});
