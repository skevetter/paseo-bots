import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { OPERATION_ID } from "./changes/ids";
import { ReceiptSchema, RoutineAuditSchema } from "./changes/receipt";
import { IssueSchema, ResolutionSchema } from "./policies";
import { RoutineRunSchema } from "./rpc";
import { ExecutionStatusSchema, TaskOutcomeSchema } from "./runs";

export const MAX_AUTOMATION_TARGETS = 500;
export const AUTOMATION_ATTENTION = [
  "permission_requests",
  "unknown_outcomes",
  "stale_models",
  "memory_failure",
  "budget_exhaustion",
] as const;
export const AutomationAttentionSchema = z.enum(AUTOMATION_ATTENTION);
export type AutomationAttention = z.infer<typeof AutomationAttentionSchema>;
const Id = z.string().min(1).max(200);
const Revision = z.string().min(1);
const OperationId = z.string().regex(OPERATION_ID);
const EvidenceFlagSchema = z.object({ value: z.boolean().nullable(), reason: z.string() });

export const AutomationRowSchema = z.object({
  id: Id,
  botId: Id,
  botName: z.string(),
  routineId: Id,
  routineName: z.string(),
  teamId: Id.nullable(),
  teamName: z.string().nullable(),
  enabled: z.boolean(),
  executionMode: z.enum(["legacy", "managed"]),
  schedule: z.object({
    kind: z.enum(["daily", "interval", "once", "cron", "webhook"]),
    description: z.string(),
    nextUtc: z.string().nullable(),
    nextLocal: z.string().nullable(),
    timeZone: z.string(),
    legacyLocalTime: z.boolean(),
    elapsed: z.boolean(),
    error: z.string().nullable(),
  }),
  lastRunId: Id.nullable(),
  lastExecutionStatus: ExecutionStatusSchema.nullable(),
  lastTaskOutcome: TaskOutcomeSchema.nullable(),
  active: z.object({
    count: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    source: z.literal("run_ledger"),
  }),
  owner: z.object({ agentId: z.string(), status: z.string() }).nullable(),
  resolution: ResolutionSchema,
  selectedModel: z.string().nullable(),
  selectionReason: z.string(),
  selectionIssues: z.array(IssueSchema),
  attention: z.object({
    permission_requests: EvidenceFlagSchema,
    unknown_outcomes: EvidenceFlagSchema,
    stale_models: EvidenceFlagSchema,
    memory_failure: EvidenceFlagSchema,
    budget_exhaustion: EvidenceFlagSchema,
  }),
  spendUsd: z.null(),
  escalationCount: z.null(),
  unavailable: z.array(z.string()),
});
export type AutomationRow = z.infer<typeof AutomationRowSchema>;

export const AutomationsFilterSchema = z.object({
  botId: Id.optional(),
  teamId: Id.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  enabled: z.boolean().optional(),
  attention: AutomationAttentionSchema.optional(),
});
export type AutomationsFilter = z.infer<typeof AutomationsFilterSchema>;
export const automationsListRpc = defineRpc({
  name: "bots.automations.list",
  input: AutomationsFilterSchema.extend({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  output: z.object({
    revision: Revision,
    rows: z.array(AutomationRowSchema),
    cursor: z.string().nullable(),
    readiness: z.enum(["waiting_for_host_api", "reconciling", "ready", "stopped"]),
    observedAt: z.string(),
  }),
});

export const AutomationChangeRequestSchema = z
  .strictObject({
    operationId: OperationId,
    revision: Revision,
    targetIds: z.array(Id).min(1).max(MAX_AUTOMATION_TARGETS),
    enabled: z.boolean(),
  })
  .superRefine((request, context) => {
    if (new Set(request.targetIds).size !== request.targetIds.length)
      context.addIssue({ code: "custom", path: ["targetIds"], message: "Select each routine only once." });
  });
export type AutomationChangeRequest = z.infer<typeof AutomationChangeRequestSchema>;

export const AutomationPreviewRowSchema = z.object({
  id: Id,
  botId: Id,
  botName: z.string(),
  routineId: Id,
  routineName: z.string(),
  beforeEnabled: z.boolean(),
  afterEnabled: z.boolean(),
  routineHash: z.string(),
  resolution: ResolutionSchema,
  incompatibilities: z.array(IssueSchema),
});
export type AutomationPreviewRow = z.infer<typeof AutomationPreviewRowSchema>;
export const AutomationPreviewSchema = z.object({
  request: AutomationChangeRequestSchema,
  digest: z.string(),
  rows: z.array(AutomationPreviewRowSchema),
  compatible: z.boolean(),
  warnings: z.array(z.string()),
  activeRunsUnaffected: z.literal(true),
});
export type AutomationPreview = z.infer<typeof AutomationPreviewSchema>;
export const AutomationReceiptSchema = ReceiptSchema.extend({
  originalRevision: Revision,
  newRevision: Revision,
  automations: RoutineAuditSchema,
});
export type AutomationReceipt = z.infer<typeof AutomationReceiptSchema>;
const ConflictSchema = z.object({ status: z.literal("conflict"), error: z.string() });
export const AutomationApplyResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), receipt: AutomationReceiptSchema, revision: Revision }),
  z.object({ status: z.literal("replayed"), receipt: AutomationReceiptSchema, revision: Revision }),
  ConflictSchema,
]);
export type AutomationApplyResult = z.infer<typeof AutomationApplyResultSchema>;
export const automationsPreviewRpc = defineRpc({
  name: "bots.automations.preview-change",
  input: AutomationChangeRequestSchema,
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("previewed"), preview: AutomationPreviewSchema }),
    ConflictSchema,
  ]),
});
export const automationsApplyRpc = defineRpc({
  name: "bots.automations.apply-change",
  input: z.strictObject({ request: AutomationChangeRequestSchema, previewDigest: z.string().min(1) }),
  output: AutomationApplyResultSchema,
});
export const automationsRevertRpc = defineRpc({
  name: "bots.automations.revert-change",
  input: z.strictObject({ operationId: OperationId, revision: Revision, appliedOperationId: OperationId }),
  output: AutomationApplyResultSchema,
});
export const automationsRunNowRpc = defineRpc({
  name: "bots.automations.run-now",
  input: z.strictObject({ botId: Id, routineId: Id, requestId: Id }),
  output: z.object({ run: RoutineRunSchema }),
});
