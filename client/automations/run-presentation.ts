import type { RpcOutput } from "@getpaseo/plugin";
import type { Source } from "../../shared/policies";
import type { RoutineRun, runsListRpc } from "../../shared/rpc";
import type { RunDetails, RunSnapshot } from "../../shared/run-details";
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
    return run.managed.reservation
      ? "Cancellation requested, not confirmed. An acknowledgment is not proof work stopped. Reservation and unknown effects are retained until reconciled."
      : `Cancellation was requested; recorded execution is ${run.executionStatus}. No coordinator reservation is retained. The task outcome is a separate fact, not proof of rollback.`;
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

function sourceFact(source: Source): string {
  return `${source.layer}${source.policyId ? ` (${source.policyId}, revision ${source.revision ?? "unavailable"})` : ""}`;
}

export function immutableSnapshotFacts(snapshot: RunSnapshot): Fact[] {
  if (snapshot.status === "unavailable") {
    return [
      ["Immutable snapshot", `Unavailable (${snapshot.reason}). Current bot settings are not substituted.`],
    ];
  }
  const execution = snapshot.execution;
  const facts: Fact[] = [
    ["Immutable snapshot", "Available; retained admitted artifact"],
    ["Snapshot artifact ID", snapshot.artifact.id],
    ["Snapshot artifact SHA-256", snapshot.artifact.sha256],
    ["Selected provider", snapshot.selected.provider],
    ["Selected model", snapshot.selected.model],
    ["Provider selection source", sourceFact(execution.provider.source)],
    ["Model selection source", sourceFact(execution.model.source)],
    ["Requested model", execution.model.value ?? "Provider default"],
    ["Thinking option", execution.thinkingOptionId.value ?? "Provider default"],
    ["Thinking source", sourceFact(execution.thinkingOptionId.source)],
    ["Approval mode", snapshot.permissions.modeId ?? "Provider default"],
    ["Approval source", sourceFact(execution.modeId.source)],
    ["Policy qualified at admission", String(execution.ok)],
    ["Routing reason", "Unavailable; policy field sources are recorded, not a routing decision"],
    ["Preapproved tool count", String(snapshot.permissions.preapprovedToolCount)],
    ["MCP server count", String(snapshot.permissions.mcpServerCount)],
    ["App count", String(snapshot.permissions.appCount)],
    ["Contact bots", snapshot.permissions.contactBots],
    ["Admitted system prompt hash", snapshot.systemPromptHash ?? "Unavailable"],
    ["Admitted user prompt hash", snapshot.userPromptHash ?? "Unavailable"],
    ["Admitted environment version", snapshot.environmentVersion ?? "Unavailable"],
  ];
  for (const [label, field, unit] of [
    ["Wall-time budget", execution.budget.maxRunSeconds, "seconds"],
    ["Cost budget", execution.budget.maxRunCostUsd, "USD"],
    ["Token budget", execution.budget.maxRunTokens, "tokens"],
    ["Concurrency limit", execution.concurrency.maxConcurrentRuns, "runs"],
  ] as const) {
    facts.push([
      label,
      `${field.value === null ? "No configured limit" : `${field.value} ${unit}`}; ${sourceFact(field.source)}`,
    ]);
  }
  facts.push([
    "Budget enforcement",
    "Configured limits are not observed spend or proof an active call can be interrupted",
  ]);
  facts.push(...snapshotContextFacts(snapshot));
  return facts;
}

function snapshotContextFacts(snapshot: Extract<RunSnapshot, { status: "available" }>): Fact[] {
  const facts: Fact[] = [];
  if (snapshot.memory) {
    const memory = snapshot.memory;
    const stats = memory.stats;
    facts.push(
      ["Memory backend", memory.backend],
      ["Memory content SHA-256", memory.contentHash],
      [
        "Memory included",
        `${stats.includedLines}/${stats.totalLines} lines; ${stats.includedBytes}/${stats.totalBytes} bytes`,
      ],
      ["Memory omitted", `${stats.omittedLines} lines; ${stats.omittedBytes} bytes`],
      ["Memory budget", `${stats.maxLines} lines; ${stats.maxBytes} bytes; estimator ${stats.estimator}`],
      ["Memory truncation", stats.truncation ?? "None"],
    );
  } else facts.push(["Memory receipt", "Unavailable"]);
  snapshot.playbooks.forEach((playbook, index) => {
    facts.push([
      `Playbook ${index + 1}`,
      `${playbook.id}; version ${playbook.version ?? "unavailable"}; SHA-256 ${playbook.contentHash}`,
    ]);
  });
  if (!snapshot.playbooks.length) facts.push(["Playbooks", "None admitted"]);
  snapshot.inputArtifacts.forEach((artifact, index) => {
    facts.push([
      `Input reference ${index + 1}`,
      `${artifact.id}; SHA-256 of private locator ${artifact.sha256}; availability not checked (not a content hash)`,
    ]);
  });
  if (!snapshot.inputArtifacts.length) facts.push(["Input references", "None admitted"]);
  return facts;
}

export function runDetailEvidenceFacts(details: RunDetails): Fact[] {
  const result = details.resultArtifacts;
  const evidence = details.evidenceArtifacts;
  const facts: Fact[] = [
    [
      "Result artifacts",
      result.status === "recorded"
        ? `${result.artifact.id}; content SHA-256 ${result.artifact.sha256}; availability not checked`
        : "Unavailable; no retained result reference",
    ],
    [
      "Evidence artifacts",
      evidence.status === "recorded"
        ? `${evidence.artifact.id}; content SHA-256 ${evidence.artifact.sha256}; availability not checked`
        : "Unavailable; no retained evidence reference",
    ],
    ["External-action receipts", "Unavailable; no receipt producer evidence"],
    ["Current stage", details.run?.executionStatus ?? "Unavailable"],
    [
      "Replay policy",
      "No task retry is offered. Reconcile unknown creation or external effects before a new occurrence; infrastructure retry resumes only a proven no-effect stage.",
    ],
  ];
  if (evidence.status === "recorded") {
    facts.push(
      ["Evidence source", evidence.source],
      ["Reply complete", String(evidence.replyComplete)],
      ["Timeline complete", String(evidence.timelineComplete)],
      ["Evidence observed at", new Date(evidence.observedAt).toISOString()],
    );
  } else
    facts.push([
      "Source completeness",
      "Unavailable; recorded creation/timeline positions do not establish a complete transcript",
    ]);
  facts.push(...recoveryFacts(details.run?.managed));
  return facts;
}

function recoveryFacts(managed: RoutineRun["managed"]): Fact[] {
  if (!managed) return [];
  const facts: Fact[] = [];
  facts.push(
    [
      "Admission time",
      managed.admittedAt === undefined ? "Unavailable" : new Date(managed.admittedAt).toISOString(),
    ],
    ["Launch authorized", managed.launchIntent === undefined ? "Unavailable" : String(managed.launchIntent)],
    [
      "Deadline",
      managed.deadlineAt == null ? "No recorded deadline" : new Date(managed.deadlineAt).toISOString(),
    ],
    [
      "Wall-time clock start",
      managed.firstReservedAt == null ? "Not recorded" : new Date(managed.firstReservedAt).toISOString(),
    ],
    [
      "Enforced wall-time budget",
      managed.maxRunSeconds == null
        ? "No recorded limit"
        : `${managed.maxRunSeconds} seconds; active termination still requires host evidence`,
    ],
    ["Cancellation error", managed.cancelError ?? "None recorded"],
  );
  return facts;
}

export function withAuthoritativeRun(details: RunDetails | undefined, run: RoutineRun): RunDetails {
  return {
    run: { ...run, output: null },
    snapshot: details?.snapshot ?? { status: "unavailable", reason: "not_loaded" },
    resultArtifacts: details?.resultArtifacts ?? { status: "unavailable" },
    evidenceArtifacts: details?.evidenceArtifacts ?? { status: "unavailable" },
    externalActionReceipts: details?.externalActionReceipts ?? { status: "unavailable" },
  };
}
