import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { WireAttachmentSchema, WireImageSchema } from "./attachments";
import { ExecutionStatusSchema, PurposeSchema, RunIdSchema, TaskOutcomeSchema } from "./runs";

export const LocalChatInputSchema = z.strictObject({
  botId: z.string().min(1),
  requestId: z.string().min(1).max(200),
  prompt: z.string(),
  title: z.string().default(""),
  purpose: PurposeSchema.default("task"),
  labels: z.record(z.string(), z.string()).default({}),
  agentId: z.uuid().optional(),
  idempotencyKey: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  clientMessageId: z.string().min(1).optional(),
  images: z.array(WireImageSchema).default([]),
  attachments: z.array(WireAttachmentSchema).default([]),
  routineId: z.string().min(1).optional(),
  deadlineAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type LocalChatInput = z.output<typeof LocalChatInputSchema>;

export const ExecutionPlanIdSchema = z.templateLiteral(["run-", z.uuid()]);
export const LocalRunSummarySchema = z.strictObject({
  id: RunIdSchema,
  executionStatus: ExecutionStatusSchema,
  taskOutcome: TaskOutcomeSchema,
  purpose: PurposeSchema,
});
export type LocalRunSummary = z.output<typeof LocalRunSummarySchema>;

export const LocalPreparedPlanSchema = z.strictObject({
  planId: ExecutionPlanIdSchema,
  plannedAgentId: z.uuid(),
  run: LocalRunSummarySchema,
});
export type LocalPreparedPlan = z.output<typeof LocalPreparedPlanSchema>;

export const LocalChatStartResultSchema = z
  .strictObject({
    status: z.enum(["created", "pending", "not_created"]),
    mode: z.enum(["legacy", "managed"]),
    agentId: z.uuid().nullable(),
    plannedAgentId: z.uuid().nullable(),
    planId: ExecutionPlanIdSchema.nullable(),
    run: LocalRunSummarySchema.nullable(),
    message: z.string().nullable(),
  })
  .superRefine((result, context) => {
    if ((result.status === "created") !== (result.agentId !== null))
      context.addIssue({
        code: "custom",
        path: ["agentId"],
        message: "Only proven creation has an agent ID.",
      });
    if (result.mode === "managed" && (!result.planId || !result.run))
      context.addIssue({
        code: "custom",
        path: ["planId"],
        message: "Managed starts retain their admitted plan.",
      });
  });
export type LocalChatStartResult = z.output<typeof LocalChatStartResultSchema>;

export const runsPrepareRpc = defineRpc({
  name: "bots.runs.prepare",
  input: LocalChatInputSchema,
  output: LocalPreparedPlanSchema,
});
export const runsStartRpc = defineRpc({
  name: "bots.runs.start",
  input: z.strictObject({ planId: ExecutionPlanIdSchema }),
  output: LocalChatStartResultSchema,
});
export const chatsStartRpc = defineRpc({
  name: "bots.chats.start",
  input: LocalChatInputSchema,
  output: LocalChatStartResultSchema,
});
