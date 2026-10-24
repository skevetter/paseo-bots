import { createHash } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PreparedChatMetadata } from "../shared/chat";
import type { ManagedRun } from "../shared/managed-runs";
import type { RoutineRun } from "../shared/rpc";
import {
  DigestRefSchema,
  type RunDetails,
  RunDetailsSchema,
  type RunSnapshot,
  runsDetailsRpc,
  type SafeRun,
} from "../shared/run-details";
import type { BotsHost } from "./host";
import type { RunCoordinator } from "./run-coordinator";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type ArtifactRef = { id: string; sha256: string };

/** Digest-only reference. Anything that is not a sha256 pair is unavailable, never echoed. */
function referenceOf(ref: ArtifactRef | undefined) {
  if (ref === undefined) return { status: "unavailable" as const, reason: "absent" as const };
  const parsed = DigestRefSchema.safeParse({ id: ref.id, sha256: ref.sha256 });
  return parsed.success
    ? { status: "recorded" as const, artifact: parsed.data, availability: "not_checked" as const }
    : { status: "unavailable" as const, reason: "invalid_reference" as const };
}

function projectManaged(managed: ManagedRun): NonNullable<SafeRun["managed"]> {
  return {
    botId: managed.botId,
    routineId: managed.routineId,
    requestId: managed.requestId,
    provider: managed.provider,
    model: managed.model,
    overlap: managed.overlap,
    overlapLimit: managed.overlapLimit,
    reservation: managed.reservation,
    clientMessageRecorded: managed.clientMessageId !== undefined,
    resourceCount: managed.resourceIds.length,
    evidencePinCount: managed.evidencePins?.length ?? 0,
    notBefore: managed.notBefore,
    admissionOrder: managed.admissionOrder ?? null,
    hostCreatedAt: managed.hostCreatedAt ?? null,
    cancelRequested: managed.cancelRequested,
    cancelDiagnostic: managed.cancelError == null ? "none" : "retained",
    coalescedInto: managed.coalescedInto,
    creation: managed.creation
      ? { revision: managed.creation.revision, outcomeUnknown: managed.creation.outcomeUnknown }
      : null,
    timelineSeq: managed.timeline?.seq ?? null,
    attempts: managed.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      executionId: attempt.executionId,
      agentId: attempt.agentId,
      number: attempt.number,
      state: attempt.state,
      diagnostic: attempt.error == null ? "none" : "retained",
    })),
  };
}

function projectRun(run: RoutineRun): SafeRun {
  const managed = run.managed;
  return {
    id: run.id,
    cycleId: run.cycleId,
    attemptId: run.attemptId,
    executionId: run.executionId,
    sessionEpoch: run.sessionEpoch,
    occurrenceKey: run.occurrenceKey,
    parentRunId: run.parentRunId,
    providerTurnRecorded: run.providerTurnId !== null,
    purpose: run.purpose,
    trigger: run.trigger,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    executionStatus: run.executionStatus,
    agentCreationStatus: run.agentCreationStatus ?? null,
    taskOutcome: run.taskOutcome,
    verification: run.verification,
    skipped: run.skipped,
    agentId: run.agentId,
    errorDiagnostic: run.error == null ? "none" : "retained",
    recovery: {
      receipt: run.recovery ?? null,
      admittedAt: managed?.admittedAt ?? null,
      launchIntent: managed?.launchIntent ?? null,
      deadlineAt: managed?.deadlineAt ?? null,
      firstReservedAt: managed?.firstReservedAt ?? null,
      maxRunSeconds: managed?.maxRunSeconds ?? null,
    },
    managed: managed ? projectManaged(managed) : null,
  };
}

function projectSnapshot(managed: ManagedRun, metadata: PreparedChatMetadata): RunSnapshot {
  const artifact = referenceOf(managed.artifact);
  if (artifact.status !== "recorded") return { status: "unavailable", reason: "invalid_reference" };
  const policy = metadata.resolvedPolicy;
  const permissions = metadata.permissionEnvelope;
  const memory = metadata.memoryContextReceipt;
  return {
    status: "available",
    artifact: artifact.artifact,
    selected: { provider: managed.provider, model: managed.model },
    execution: {
      ok: policy.ok,
      provider: policy.provider,
      model: policy.model,
      thinkingOptionId: policy.thinkingOptionId,
      modeId: policy.modeId,
      budget: policy.budget,
      concurrency: policy.concurrency,
    },
    routingReason: null,
    permissions: {
      modeId: permissions.modeId,
      contactBots: permissions.contactBots,
      preapprovedToolCount: permissions.alwaysAllow.length,
      mcpServerCount: permissions.mcpServerNames.length,
      appCount: permissions.apps.length,
    },
    systemPromptHash: metadata.systemPromptHash,
    userPromptHash: metadata.userPromptHash,
    environmentVersionFingerprint:
      metadata.environmentVersion === null ? null : sha256(metadata.environmentVersion),
    memory: memory ? { backend: memory.backend, contentHash: memory.contentHash, stats: memory.stats } : null,
    playbooks: metadata.playbooks.map(({ id, version, contentHash }) => ({ id, version, contentHash })),
    inputArtifacts: metadata.inputArtifactRefs.map((locator) => ({
      id: `sha256:${sha256(locator)}`,
      sha256: sha256(locator),
      availability: "not_checked",
    })),
  };
}

export async function getRunDetails(
  coordinator: Pick<RunCoordinator, "get" | "snapshot">,
  runId: string,
): Promise<RunDetails> {
  const run = await coordinator.get(runId);
  const managed = run?.managed;
  let snapshot: RunSnapshot = {
    status: "unavailable",
    reason: run ? "not_managed" : "run_not_found",
  };
  if (run && managed) {
    const retained = await coordinator.snapshot(runId);
    snapshot =
      retained.status === "available"
        ? projectSnapshot(managed, retained.metadata)
        : { status: "unavailable", reason: "retained_snapshot_unavailable" };
  }
  const evidence = managed?.evidence;
  const evidenceRef = referenceOf(evidence?.artifact);
  // Parsing enforces the allowlist; no raw reply, error, or locator text is ever returned.
  return RunDetailsSchema.parse({
    run: run ? projectRun(run) : null,
    snapshot,
    resultArtifacts: referenceOf(managed?.result),
    evidenceArtifacts:
      evidence && evidenceRef.status === "recorded"
        ? {
            ...evidenceRef,
            source: evidence.source,
            replyComplete: evidence.replyComplete,
            timelineComplete: evidence.timelineComplete,
            observedAt: evidence.observedAt,
          }
        : evidenceRef,
    externalActionReceipts: { status: "unavailable" },
  });
}

export function registerRunDetails(
  server: PluginServerContext,
  host: BotsHost,
  coordinator: RunCoordinator,
): void {
  server.handle(runsDetailsRpc, ({ runId }, context) => {
    host.attach(context.paseo);
    return getRunDetails(coordinator, runId);
  });
}
