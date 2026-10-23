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
  requestHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  admissionOrder: z.number().int().nonnegative().safe().optional(),
  admittedAt: z.number().int().nonnegative().safe().optional(),
  launchIntent: z.boolean().optional(),
  deadlineAt: z.number().int().nonnegative().safe().nullable().optional(),
  firstReservedAt: z.number().int().nonnegative().safe().nullable().optional(),
  maxRunSeconds: z.number().int().positive().nullable().optional(),
  cancelError: z.string().nullable().optional(),
  result: ArtifactRefSchema.optional(),
  evidence: z
    .object({
      artifact: ArtifactRefSchema,
      source: z.enum(["lifecycle", "timeline"]),
      replyComplete: z.boolean(),
      timelineComplete: z.boolean(),
      observedAt: z.number(),
    })
    .optional(),
  evidencePins: z.array(z.string()).optional(),
  hostCreatedAt: z.number().optional(),
});
export type ManagedRun = z.infer<typeof ManagedRunSchema>;
export const SessionOpeningSchema = z.object({
  sessionEpoch: z.number().int().nonnegative().safe(),
  requestId: z.string(),
  executionId: z.string(),
  workspaceId: z.string().nullable(),
  provider: z.string(),
  cwd: z.string(),
  reason: z.enum(["create", "resume", "refresh", "import"]),
  state: z.enum(["pending", "active"]),
  openedAt: z.number(),
  activeAt: z.number().nullable(),
});
export type SessionOpening = z.infer<typeof SessionOpeningSchema>;
export const CoordinatorStateSchema = z.object({
  occurrences: z.record(z.string(), z.string()),
  circuits: z.record(z.string(), CircuitStateSchema),
  requests: z
    .record(
      z.string(),
      z.object({
        runId: z.string(),
        recordId: z.string(),
        botId: z.string(),
        requestHash: z.string().nullable(),
        mode: z.enum(["legacy", "managed"]),
      }),
    )
    .default({}),
  admissionOrder: z.number().int().nonnegative().safe().default(0),
  sessions: z.record(z.string(), z.array(SessionOpeningSchema)).default({}),
});
export type CoordinatorState = z.infer<typeof CoordinatorStateSchema>;
export type HostReadiness = "waiting_for_host_api" | "reconciling" | "ready" | "stopped";
export const RUN_LABEL = "paseo-bots.run";
export const EXECUTION_LABEL = "paseo-bots.execution";
export const OCCURRENCE_LABEL = "paseo-bots.occurrence";
