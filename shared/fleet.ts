import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BotSchema } from "./bot";
import { OPERATION_ID } from "./changes/ids";
import { ReceiptSchema } from "./changes/receipt";
import {
  closeInheritance,
  INHERITABLE,
  IssueSchema,
  PolicyBindingSchema,
  PolicySchema,
  ResolutionSchema,
} from "./policies";
import { ExecutionStatusSchema, TaskOutcomeSchema } from "./runs";

export const MAX_FLEET_TARGETS = 500;
const OperationId = z.string().regex(OPERATION_ID);
const Revision = z.string().min(1);
const InheritableSchema = z.enum(INHERITABLE);

export const FleetPatchSchema = z.strictObject({
  binding: PolicyBindingSchema.nullable().optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).nullable().optional(),
  thinkingOptionId: z.string().min(1).nullable().optional(),
});
export type FleetPatch = z.infer<typeof FleetPatchSchema>;

export const FleetChangeRequestSchema = z
  .strictObject({
    operationId: OperationId,
    revision: Revision,
    botIds: z.array(z.string().min(1)).min(1).max(MAX_FLEET_TARGETS),
    patch: FleetPatchSchema,
    unset: z.array(InheritableSchema).max(INHERITABLE.length).default([]),
  })
  .superRefine((request, context) => {
    if (new Set(request.botIds).size !== request.botIds.length)
      context.addIssue({ code: "custom", path: ["botIds"], message: "Select each bot only once." });
    if (new Set(request.unset).size !== request.unset.length)
      context.addIssue({ code: "custom", path: ["unset"], message: "Reset each field only once." });
    if (Object.keys(request.patch).length === 0 && request.unset.length === 0)
      context.addIssue({
        code: "custom",
        path: ["patch"],
        message: "Choose a change or reset a field to inherited.",
      });
    for (const field of closeInheritance(request.unset)) {
      if (request.patch[field] !== undefined)
        context.addIssue({
          code: "custom",
          path: ["patch", field],
          message: "A field cannot be both overridden and inherited.",
        });
    }
  });
export type FleetChangeRequest = z.infer<typeof FleetChangeRequestSchema>;

export const FleetPreviewRowSchema = z.object({
  botId: z.string(),
  name: z.string(),
  before: BotSchema,
  after: BotSchema,
  beforeResolution: ResolutionSchema,
  afterResolution: ResolutionSchema,
  incompatibilities: z.array(IssueSchema),
});
export type FleetPreviewRow = z.infer<typeof FleetPreviewRowSchema>;

export const FleetPreviewSchema = z.object({
  request: FleetChangeRequestSchema,
  digest: z.string(),
  rows: z.array(FleetPreviewRowSchema),
  warnings: z.array(z.string()),
  activeChatsUnaffected: z.literal(true),
  compatible: z.boolean(),
});
export type FleetPreview = z.infer<typeof FleetPreviewSchema>;

export const FleetReceiptSchema = ReceiptSchema.extend({
  originalRevision: Revision,
  newRevision: Revision,
});
export type FleetReceipt = z.infer<typeof FleetReceiptSchema>;

const ConflictSchema = z.object({ status: z.literal("conflict"), error: z.string() });
export const FleetApplyResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), receipt: FleetReceiptSchema, revision: Revision }),
  z.object({ status: z.literal("replayed"), receipt: FleetReceiptSchema, revision: Revision }),
  ConflictSchema,
]);
export type FleetApplyResult = z.infer<typeof FleetApplyResultSchema>;

export const fleetPreviewRpc = defineRpc({
  name: "bots.fleet.preview-change",
  input: FleetChangeRequestSchema,
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("previewed"), preview: FleetPreviewSchema }),
    ConflictSchema,
  ]),
});

export const fleetApplyRpc = defineRpc({
  name: "bots.fleet.apply-change",
  input: z.strictObject({ request: FleetChangeRequestSchema, previewDigest: z.string().min(1) }),
  output: FleetApplyResultSchema,
});

export const fleetRevertRpc = defineRpc({
  name: "bots.fleet.revert-change",
  input: z.strictObject({ operationId: OperationId, revision: Revision, appliedOperationId: OperationId }),
  output: FleetApplyResultSchema,
});

export const FleetRowSchema = z.object({
  bot: BotSchema,
  resolution: ResolutionSchema,
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  lastOutcome: TaskOutcomeSchema,
  executionStatus: ExecutionStatusSchema.nullable(),
  activeWork: z.number().int().nonnegative().nullable(),
  spendUsd: z.number().nonnegative().nullable(),
  attention: z.array(z.string()),
});
export type FleetRow = z.infer<typeof FleetRowSchema>;

export const fleetListRpc = defineRpc({
  name: "bots.fleet.list",
  input: z.object({}),
  output: z.object({ revision: Revision, rows: z.array(FleetRowSchema), policies: z.array(PolicySchema) }),
});
