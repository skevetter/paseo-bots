import type { RpcOutput } from "@getpaseo/plugin";
import type { RoutineRun, runsListRpc } from "../../shared/rpc";
import { isTerminal } from "../../shared/runs";

export type Readiness = RpcOutput<typeof runsListRpc>["readiness"];
export type Fact = readonly [label: string, value: string];

export function readinessMessage(readiness: Readiness): string {
  switch (readiness) {
    case "waiting_for_host_api":
      return "Waiting for host API. Attach to the host normally; no hidden chat will be launched to wake it.";
    case "reconciling":
      return "Reconciling persisted runs with host evidence. Unknown effects remain unknown.";
    case "ready":
      return "Coordinator ready. Execution completion is not task verification.";
    case "stopped":
      return "Coordinator stopped. Persisted run history is still shown.";
  }
}

export function cancellationMessage(run: RoutineRun): string | null {
  if (run.executionStatus === "canceled")
    return run.taskOutcome === "unknown"
      ? "Execution canceled; external effects remain unknown. Cancellation is not proof of rollback."
      : "Execution canceled. The task outcome is recorded separately; cancellation is not proof of rollback.";
  if (run.managed?.cancelRequested)
    return "Cancellation requested, not confirmed. This SDK cannot interrupt active work. Reservation and unknown effects are retained until reconciled.";
  if (run.executionStatus === "unknown")
    return "Execution and external effects are unknown. Reconcile before assuming this work stopped or retrying it.";
  return null;
}

export function canRequestCancel(run: RoutineRun): boolean {
  return (
    !!run.managed &&
    (!isTerminal(run.executionStatus) || (run.executionStatus === "unknown" && run.managed.reservation))
  );
}

export function elapsedFact(run: RoutineRun, now: number): string {
  const start = Date.parse(run.startedAt);
  const end = run.endedAt === null ? now : Date.parse(run.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "Unavailable";
  const seconds = Math.floor((end - start) / 1_000);
  const duration =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3_600
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${duration}${run.endedAt === null ? " since recorded start; end not observed" : " between recorded start and end"}`;
}

/** Metadata allowlist: never serialize the snapshot, prompts, environment or artifact content. */
export function snapshotFacts(run: RoutineRun): Fact[] {
  const managed = run.managed;
  if (!managed) return [["Snapshot", "No managed snapshot metadata available for this record"]];
  return [
    ["Bot ID", managed.botId],
    ["Routine ID", managed.routineId ?? "None (ordinary chat)"],
    ["Request ID", managed.requestId],
    ["Artifact ID", managed.artifact.id],
    ["Artifact SHA-256", managed.artifact.sha256],
    ["Provider", managed.provider],
    ["Model", managed.model ?? "Provider default"],
    ["System prompt hash", managed.systemPromptHash ?? "Unavailable"],
    ["User prompt hash", managed.userPromptHash ?? "Unavailable"],
    ["Environment version", managed.environmentVersion ?? "Unavailable"],
    ["Resource IDs", managed.resourceIds.join(", ") || "None"],
    ...coordinationFacts(run),
  ];
}

function coordinationFacts(run: RoutineRun): Fact[] {
  const managed = run.managed;
  if (!managed) return [];
  const facts: Fact[] = [
    ["Overlap policy", managed.overlap],
    ["Overlap limit", String(managed.overlapLimit)],
    ["Client message ID", managed.clientMessageId ?? "Not recorded"],
    ["Reservation retained", String(managed.reservation)],
    ["Not before", new Date(managed.notBefore).toISOString()],
    ["Cancellation requested", String(managed.cancelRequested)],
    ["Coalesced into", managed.coalescedInto ?? "None"],
  ];
  if (managed.timeline)
    facts.push(
      ["Timeline epoch", managed.timeline.epoch],
      ["Timeline sequence", String(managed.timeline.seq)],
    );
  else facts.push(["Timeline evidence", "Not observed"]);
  if (managed.creation)
    facts.push(
      ["Creation key", managed.creation.key],
      ["Creation revision", String(managed.creation.revision)],
      ["Creation phase", managed.creation.phase],
      ["Creation outcome unknown", String(managed.creation.outcomeUnknown)],
    );
  else facts.push(["Creation evidence", "Not recorded"]);
  return facts;
}
