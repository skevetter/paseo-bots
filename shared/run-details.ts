import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { AttemptEvidenceSchema, OverlapSchema } from "./managed-runs";
import { MemoryBudgetStatsSchema } from "./memory-budget";
import { ResolutionSchema } from "./policies";
import {
  AgentCreationStatusSchema,
  AttemptIdSchema,
  CycleIdSchema,
  ExecutionIdSchema,
  ExecutionStatusSchema,
  OccurrenceKeySchema,
  PurposeSchema,
  RunIdSchema,
  runStateIssue,
  ScheduleRecoveryReceiptSchema,
  SessionEpochSchema,
  SkippedSchema,
  TaskOutcomeSchema,
  TRIGGERS,
  VerificationSchema,
} from "./runs";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

/** A local content-addressed reference; neither locator text nor mismatched digest pairs qualify. */
export const DigestRefSchema = z
  .strictObject({ id: Hash, sha256: Hash })
  .refine((ref) => ref.id === ref.sha256, "Artifact id must equal its content digest.");
export type DigestRef = z.infer<typeof DigestRefSchema>;

/** Presence only. Retained failure text (run error, cancel error, attempt error) never reaches this surface. */
export const DiagnosticSchema = z.enum(["none", "retained"]);
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

const ReferenceUnavailableSchema = z.strictObject({
  status: z.literal("unavailable"),
  reason: z.enum(["absent", "invalid_reference"]),
});
const RecordedArtifactSchema = z.strictObject({
  status: z.literal("recorded"),
  artifact: DigestRefSchema,
  availability: z.literal("not_checked"),
});
const ResultArtifactsSchema = z.discriminatedUnion("status", [
  ReferenceUnavailableSchema,
  RecordedArtifactSchema,
]);
const EvidenceArtifactsSchema = z.discriminatedUnion("status", [
  ReferenceUnavailableSchema,
  RecordedArtifactSchema.extend({
    source: z.enum(["lifecycle", "timeline"]),
    replyComplete: z.boolean(),
    timelineComplete: z.boolean(),
    observedAt: z.number(),
  }),
]);
const UnavailableEvidenceSchema = z.strictObject({ status: z.literal("unavailable") });

export const RunSnapshotSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    artifact: DigestRefSchema,
    selected: z.strictObject({ provider: z.string(), model: z.string() }),
    execution: ResolutionSchema.pick({
      ok: true,
      provider: true,
      model: true,
      thinkingOptionId: true,
      modeId: true,
      budget: true,
      concurrency: true,
    }),
    routingReason: z.null(),
    permissions: z.strictObject({
      modeId: z.string().nullable(),
      contactBots: z.enum(["off", "ask", "allow"]),
      preapprovedToolCount: z.number().int().nonnegative(),
      mcpServerCount: z.number().int().nonnegative(),
      appCount: z.number().int().nonnegative(),
    }),
    systemPromptHash: Hash.nullable(),
    userPromptHash: Hash.nullable(),
    /** SHA-256 of the environment version label; the label itself is withheld. */
    environmentVersionFingerprint: Hash.nullable(),
    memory: z
      .strictObject({ backend: z.literal("files"), contentHash: Hash, stats: MemoryBudgetStatsSchema })
      .nullable(),
    playbooks: z.array(z.strictObject({ id: z.string(), version: z.string().optional(), contentHash: Hash })),
    inputArtifacts: z.array(
      z
        .strictObject({
          id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          sha256: Hash,
          availability: z.literal("not_checked"),
        })
        .refine((ref) => ref.id === `sha256:${ref.sha256}`, "Locator fingerprint must match its identity."),
    ),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum([
      "run_not_found",
      "not_managed",
      "retained_snapshot_unavailable",
      "invalid_reference",
      "not_loaded",
    ]),
  }),
]);
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

/** Scheduler recovery facts retained on the managed run; `receipt` is the typed recovery record. */
const RecoverySchema = z.strictObject({
  receipt: ScheduleRecoveryReceiptSchema.nullable(),
  admittedAt: z.number().nullable(),
  launchIntent: z.boolean().nullable(),
  deadlineAt: z.number().nullable(),
  firstReservedAt: z.number().nullable(),
  maxRunSeconds: z.number().nullable(),
});

const SafeAttemptSchema = z.strictObject({
  attemptId: z.string(),
  executionId: z.string(),
  agentId: z.string(),
  number: z.number().int(),
  state: AttemptEvidenceSchema.shape.state,
  diagnostic: DiagnosticSchema,
});

const SafeManagedSchema = z.strictObject({
  botId: z.string(),
  routineId: z.string().nullable(),
  requestId: z.string(),
  provider: z.string(),
  model: z.string(),
  overlap: OverlapSchema,
  overlapLimit: z.number().int().positive(),
  reservation: z.boolean(),
  clientMessageRecorded: z.boolean(),
  resourceCount: z.number().int().nonnegative(),
  evidencePinCount: z.number().int().nonnegative(),
  notBefore: z.number(),
  admissionOrder: z.number().int().nonnegative().nullable(),
  /** Historical positive host evidence, independent of whether a newer creation-status field exists. */
  hostCreatedAt: z.number().nullable(),
  cancelRequested: z.boolean(),
  cancelDiagnostic: DiagnosticSchema,
  coalescedInto: z.string().nullable(),
  creation: z.strictObject({ revision: z.number(), outcomeUnknown: z.boolean() }).nullable(),
  timelineSeq: z.number().nullable(),
  attempts: z.array(SafeAttemptSchema),
});

/** Explicit allowlist projection of a routine run. Free-text fields are never copied. */
export const SafeRunSchema = z
  .strictObject({
    id: RunIdSchema,
    cycleId: CycleIdSchema,
    attemptId: AttemptIdSchema,
    executionId: ExecutionIdSchema,
    sessionEpoch: SessionEpochSchema,
    occurrenceKey: OccurrenceKeySchema,
    parentRunId: RunIdSchema.nullable(),
    providerTurnRecorded: z.boolean(),
    purpose: PurposeSchema,
    trigger: z.enum(TRIGGERS),
    scheduledFor: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    executionStatus: ExecutionStatusSchema,
    agentCreationStatus: AgentCreationStatusSchema.nullable(),
    taskOutcome: TaskOutcomeSchema,
    verification: VerificationSchema.nullable(),
    /** Admission disposition only: not proof of task outcome, host creation, or external effects. */
    skipped: SkippedSchema.nullable(),
    agentId: z.string().nullable(),
    errorDiagnostic: DiagnosticSchema,
    recovery: RecoverySchema,
    managed: SafeManagedSchema.nullable(),
  })
  .superRefine((run, context) => {
    const issue = runStateIssue(run);
    if (issue) context.addIssue({ code: "custom", path: ["taskOutcome"], message: issue });
  });
export type SafeRun = z.infer<typeof SafeRunSchema>;

/** Positive ACK or historical host evidence proves creation; a planned identity never does. */
export function hasCreationProof(run: {
  agentCreationStatus?: z.infer<typeof AgentCreationStatusSchema> | null;
  managed?: { hostCreatedAt?: number | null } | null;
}): boolean {
  return run.agentCreationStatus === "created" || run.managed?.hostCreatedAt != null;
}

export const RunDetailsSchema = z.strictObject({
  run: SafeRunSchema.nullable(),
  snapshot: RunSnapshotSchema,
  resultArtifacts: ResultArtifactsSchema,
  evidenceArtifacts: EvidenceArtifactsSchema,
  externalActionReceipts: UnavailableEvidenceSchema,
});
export type RunDetails = z.infer<typeof RunDetailsSchema>;

export const runsDetailsRpc = defineRpc({
  name: "bots.runs.details",
  input: z.object({ runId: RunIdSchema }),
  output: RunDetailsSchema,
});
