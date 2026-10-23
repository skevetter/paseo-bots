import { z } from "zod";

export const ArtifactRefSchema = z.object({ id: z.string(), sha256: z.string() });
export const CapacityLimitsSchema = z.object({
  global: z.number().int().positive(),
  perProvider: z.number().int().positive(),
  perBot: z.number().int().positive(),
  perResource: z.number().int().positive(),
});
export const OverlapSchema = z.enum(["skip", "queue", "coalesce"]);
export const CircuitStateSchema = z.object({
  failures: z.number(),
  openUntil: z.number(),
  probe: z.boolean(),
});
export const AttemptEvidenceSchema = z.object({
  attemptId: z.string(),
  executionId: z.string(),
  agentId: z.string(),
  idempotencyKey: z.string(),
  number: z.number().int().min(1).max(3),
  state: z.enum(["reserved", "starting", "running", "failed", "completed", "canceled", "unknown"]),
  error: z.string().nullable(),
});
export const ManagedRunSchema = z.object({
  botId: z.string(),
  routineId: z.string().nullable(),
  requestId: z.string(),
  artifact: ArtifactRefSchema,
  provider: z.string(),
  model: z.string(),
  systemPromptHash: z.string().nullable(),
  userPromptHash: z.string().nullable(),
  environmentVersion: z.string().nullable(),
  resourceIds: z.array(z.string()),
  overlap: OverlapSchema,
  overlapLimit: z.number().int().positive().default(1),
  reservation: z.boolean(),
  clientMessageId: z.string().optional(),
  notBefore: z.number(),
  attempts: z.array(AttemptEvidenceSchema),
  timeline: z.object({ epoch: z.string(), seq: z.number() }).nullable(),
  creation: z
    .object({
      key: z.string(),
      revision: z.number(),
      phase: z.string(),
      outcomeUnknown: z.boolean(),
    })
    .nullable(),
  cancelRequested: z.boolean(),
  coalescedInto: z.string().nullable(),
});
export type ManagedRun = z.infer<typeof ManagedRunSchema>;
export const CoordinatorStateSchema = z.object({
  occurrences: z.record(z.string(), z.string()),
  circuits: z.record(z.string(), CircuitStateSchema),
});
export type CoordinatorState = z.infer<typeof CoordinatorStateSchema>;
export type HostReadiness = "waiting_for_host_api" | "reconciling" | "ready" | "stopped";
export const RUN_LABEL = "paseo-bots.run";
export const EXECUTION_LABEL = "paseo-bots.execution";
export const OCCURRENCE_LABEL = "paseo-bots.occurrence";
