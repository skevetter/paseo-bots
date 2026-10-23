import { createHash } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PreparedChatMetadata } from "../shared/chat";
import type { RoutineRun } from "../shared/rpc";
import { type RunDetails, RunDetailsSchema, type RunSnapshot, runsDetailsRpc } from "../shared/run-details";
import type { BotsHost } from "./host";
import type { RunCoordinator } from "./run-coordinator";

function projectSnapshot(run: RoutineRun, metadata: PreparedChatMetadata): RunSnapshot {
  const managed = run.managed;
  if (!managed) return { status: "unavailable", reason: "not_managed" };
  const policy = metadata.resolvedPolicy;
  const permissions = metadata.permissionEnvelope;
  return {
    status: "available",
    artifact: { id: managed.artifact.id, sha256: managed.artifact.sha256 },
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
    environmentVersion: metadata.environmentVersion,
    memory: metadata.memoryContextReceipt,
    playbooks: metadata.playbooks.map(({ id, version, contentHash }) => ({ id, version, contentHash })),
    inputArtifacts: metadata.inputArtifactRefs.map((locator) => {
      const sha256 = createHash("sha256").update(locator).digest("hex");
      return { id: `sha256:${sha256}`, sha256, availability: "not_checked" };
    }),
  };
}

export async function getRunDetails(
  coordinator: Pick<RunCoordinator, "get" | "snapshot">,
  runId: string,
): Promise<RunDetails> {
  const run = await coordinator.get(runId);
  let snapshot: RunSnapshot = {
    status: "unavailable",
    reason: run ? "not_managed" : "run_not_found",
  };
  if (run?.managed) {
    const retained = await coordinator.snapshot(runId);
    snapshot =
      retained.status === "available"
        ? projectSnapshot(run, retained.metadata)
        : { status: "unavailable", reason: "retained_snapshot_unavailable" };
  }
  const result = run?.managed?.result;
  const evidence = run?.managed?.evidence;
  // Parsing detaches the response and strips unknown nested fields; raw reply text is never returned.
  return RunDetailsSchema.parse({
    run: run ? { ...run, output: null } : null,
    snapshot,
    resultArtifacts: result
      ? {
          status: "recorded",
          artifact: { id: result.id, sha256: result.sha256 },
          availability: "not_checked",
        }
      : { status: "unavailable" },
    evidenceArtifacts: evidence
      ? {
          status: "recorded",
          artifact: { id: evidence.artifact.id, sha256: evidence.artifact.sha256 },
          availability: "not_checked",
          source: evidence.source,
          replyComplete: evidence.replyComplete,
          timelineComplete: evidence.timelineComplete,
          observedAt: evidence.observedAt,
        }
      : { status: "unavailable" },
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
