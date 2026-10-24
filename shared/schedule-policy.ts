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

export const CatchUpSchema = z.strictObject({
  windowSeconds: z.number().int().min(60).max(604800),
  maxOccurrences: z.number().int().min(1).max(100),
  strategy: z.enum(["latest", "queue", "coalesce"]),
});
export type CatchUp = z.infer<typeof CatchUpSchema>;

export const SchedulePolicySchema = z.strictObject({
  version: z.literal(1),
  timeZone: TimeZoneSchema,
  gap: z.enum(["skip", "shift_forward"]),
  repeat: z.enum(["first", "second", "both"]),
  /** Absent on policies saved before recovery settings; see recoveryOf. */
  catchUp: CatchUpSchema.optional(),
  /** Absent on policies saved before recovery settings; see recoveryOf. */
  jitterToleranceSeconds: z.number().int().min(0).max(3600).optional(),
});
export type SchedulePolicy = z.infer<typeof SchedulePolicySchema>;

const DEFAULT_CATCH_UP: CatchUp = { windowSeconds: 43_200, maxOccurrences: 1, strategy: "coalesce" };

/** Effective recovery settings; fills defaults for policies saved without them. */
export function recoveryOf(policy: SchedulePolicy): {
  catchUp: CatchUp;
  jitterToleranceSeconds: number;
} {
  return {
    catchUp: policy.catchUp ?? DEFAULT_CATCH_UP,
    jitterToleranceSeconds: policy.jitterToleranceSeconds ?? 0,
  };
}

export function newSchedulePolicy(
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): SchedulePolicy {
  return SchedulePolicySchema.parse({
    version: 1,
    timeZone,
    gap: "skip",
    repeat: "first",
    catchUp: { ...DEFAULT_CATCH_UP },
    jitterToleranceSeconds: 0,
  });
}
