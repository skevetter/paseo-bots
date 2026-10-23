import { z } from "zod";

export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((timeZone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone }).format(0);
      return true;
    } catch {
      return false;
    }
  }, "Choose a supported IANA time zone.");

export const SchedulePolicySchema = z.strictObject({
  version: z.literal(1),
  timeZone: TimeZoneSchema,
  gap: z.enum(["skip", "shift_forward"]),
  repeat: z.enum(["first", "second", "both"]),
});
export type SchedulePolicy = z.infer<typeof SchedulePolicySchema>;

export function newSchedulePolicy(
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): SchedulePolicy {
  return SchedulePolicySchema.parse({ version: 1, timeZone, gap: "skip", repeat: "first" });
}
