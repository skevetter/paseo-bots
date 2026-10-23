import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ArtifactRefSchema } from "./managed-runs";
import { MemoryBudgetStatsSchema } from "./memory-budget";
import { ResolutionSchema } from "./policies";
import { RoutineRunSchema } from "./rpc";
import { RunIdSchema } from "./runs";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const UnavailableEvidenceSchema = z.object({ status: z.literal("unavailable") });
const RecordedArtifactSchema = z.object({
  status: z.literal("recorded"),
  artifact: ArtifactRefSchema,
  availability: z.literal("not_checked"),
});
const ResultArtifactsSchema = z.discriminatedUnion("status", [
  UnavailableEvidenceSchema,
  RecordedArtifactSchema,
]);
const EvidenceArtifactsSchema = z.discriminatedUnion("status", [
  UnavailableEvidenceSchema,
  RecordedArtifactSchema.extend({
    source: z.enum(["lifecycle", "timeline"]),
    replyComplete: z.boolean(),
    timelineComplete: z.boolean(),
    observedAt: z.number(),
  }),
]);

export const RunSnapshotSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    artifact: ArtifactRefSchema,
    selected: z.object({ provider: z.string(), model: z.string() }),
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
    permissions: z.object({
      modeId: z.string().nullable(),
      contactBots: z.enum(["off", "ask", "allow"]),
      preapprovedToolCount: z.number().int().nonnegative(),
      mcpServerCount: z.number().int().nonnegative(),
      appCount: z.number().int().nonnegative(),
    }),
    systemPromptHash: Hash.nullable(),
    userPromptHash: Hash.nullable(),
    environmentVersion: z.string().nullable(),
    memory: z
      .object({ backend: z.literal("files"), contentHash: Hash, stats: MemoryBudgetStatsSchema })
      .nullable(),
    playbooks: z.array(z.object({ id: z.string(), version: z.string().optional(), contentHash: Hash })),
    inputArtifacts: z.array(
      z.object({ id: z.string(), sha256: Hash, availability: z.literal("not_checked") }),
    ),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum(["run_not_found", "not_managed", "retained_snapshot_unavailable", "not_loaded"]),
  }),
]);
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

export const RunDetailsSchema = z.object({
  run: RoutineRunSchema.safeExtend({ output: z.null() }).nullable(),
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
