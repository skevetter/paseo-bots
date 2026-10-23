import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import { type AutomationRow, type AutomationsFilter, automationsListRpc } from "../shared/automations";
import { BOT_LABEL, type BotState, type Routine } from "../shared/bot";
import { defaultModelId } from "../shared/bot-agent";
import type { ProviderInfo } from "../shared/changes/context";
import { ROUTINE_LABEL } from "../shared/chat";
import { teamOf } from "../shared/groups";
import { resolveBot, snapshotCapabilities } from "../shared/policies";
import { describeSchedule } from "../shared/routines";
import type { RoutineRecord, RoutineRun } from "../shared/rpc";
import { isTerminal } from "../shared/runs";
import { hostProviders } from "./apply-context";
import { type AutomationTarget, automationHash, automationTargets } from "./automation-targets";
import type { BotsHost } from "./host";
import { selectionIssues } from "./policy-selection";
import type { RunCoordinator } from "./run-coordinator";
import { previewSchedule } from "./schedule-preview";

interface ObservedAgent {
  id: string;
  botId: string;
  routineId: string;
  status: string;
  permissionWaiting: boolean;
}
interface HostObservation {
  agents: ObservedAgent[];
  complete: boolean;
}

async function observeHost(host: BotsHost): Promise<HostObservation> {
  if (!host.paseo) return { agents: [], complete: false };
  try {
    const snapshot = await host.paseo.agents.list();
    const agents: ObservedAgent[] = [];
    for (const { agent } of snapshot.entries) {
      const botId = agent.labels?.[BOT_LABEL];
      const routineId = agent.labels?.[ROUTINE_LABEL];
      if (botId && routineId && !agent.archivedAt)
        agents.push({
          id: agent.id,
          botId,
          routineId,
          status: agent.status,
          permissionWaiting: agent.pendingPermissions.length > 0,
        });
    }
    return { agents, complete: !snapshot.pageInfo.hasMore };
  } catch {
    return { agents: [], complete: false };
  }
}

function scheduleProjection(
  routine: Routine,
  record: RoutineRecord | undefined,
  now: Date,
): AutomationRow["schedule"] {
  const timeZone = routine.schedulePolicy?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const base = {
    kind: routine.schedule.kind,
    description: describeSchedule(routine.schedule, routine.schedulePolicy),
    timeZone,
    legacyLocalTime:
      !routine.schedulePolicy && (routine.schedule.kind === "daily" || routine.schedule.kind === "cron"),
    elapsed: routine.schedule.kind === "interval",
  };
  try {
    const result = previewSchedule({
      schedule: routine.schedule,
      schedulePolicy: routine.schedulePolicy,
      since: record?.lastRunAt ?? routine.createdAt,
      after: now.toISOString(),
      count: 1,
    });
    const occurrence = result.occurrences[0];
    return {
      ...base,
      nextUtc: occurrence?.at ?? null,
      nextLocal: occurrence?.localTime ?? null,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      nextUtc: null,
      nextLocal: null,
      error: error instanceof Error ? error.message : "Schedule preview unavailable",
    };
  }
}

function ledgerRuns(
  target: AutomationTarget,
  record: RoutineRecord | undefined,
  routineOwners: Map<string, number>,
): RoutineRun[] {
  return (record?.runs ?? []).filter((run) =>
    run.managed
      ? run.managed.botId === target.bot.id && run.managed.routineId === target.routine.id
      : routineOwners.get(target.routine.id) === 1,
  );
}

function ownedScheduleRecord(
  record: RoutineRecord | undefined,
  runs: RoutineRun[],
  ownerCount: number | undefined,
): RoutineRecord | undefined {
  if (ownerCount === 1) return record;
  let lastRunAt: string | null = null;
  for (const run of runs) if (run.trigger === "schedule") lastRunAt = run.scheduledFor;
  return { lastRunAt, runs };
}

function ledgerSummary(runs: RoutineRun[]) {
  const latest = runs.at(-1);
  const active: RoutineRun[] = [];
  for (const run of runs) {
    if (!isTerminal(run.executionStatus) || (run.executionStatus === "unknown" && run.managed?.reservation))
      active.push(run);
  }
  return { latest, active };
}

function observedOwner(observed: ObservedAgent[], complete: boolean): AutomationRow["owner"] {
  if (!complete) return null;
  const owners = observed.filter(
    (agent) => agent.status === "running" || agent.status === "initializing" || agent.permissionWaiting,
  );
  const owner = owners[0];
  return owners.length === 1 && owner ? { agentId: owner.id, status: owner.status } : null;
}

function permissionEvidence(
  waiting: number,
  observed: ObservedAgent[],
  complete: boolean,
): AutomationRow["attention"]["permission_requests"] {
  if (waiting > 0 || observed.some((agent) => agent.permissionWaiting))
    return { value: true, reason: "Permission wait observed in retained execution or host snapshot." };
  if (complete) return { value: false, reason: "No permission wait in the complete host snapshot." };
  return { value: null, reason: "Host permission evidence unavailable or incomplete." };
}

function runEvidence(runs: RoutineRun[], observed: ObservedAgent[], complete: boolean) {
  const { latest, active } = ledgerSummary(runs);
  const last = latest ?? { id: null, executionStatus: null, taskOutcome: null };
  const waiting = active.filter((run) => run.executionStatus === "waiting_for_user").length;
  const unknown =
    runs.some((run) => run.executionStatus === "unknown") ||
    (!!latest && isTerminal(latest.executionStatus) && latest.taskOutcome === "unknown");
  return {
    lastRunId: last.id,
    lastExecutionStatus: last.executionStatus,
    lastTaskOutcome: last.taskOutcome,
    active: {
      count: active.length,
      waiting,
      unknown: active.filter((run) => run.executionStatus === "unknown").length,
      source: "run_ledger" as const,
    },
    owner: observedOwner(observed, complete),
    permission: permissionEvidence(waiting, observed, complete),
    unknown: {
      value: runs.length ? unknown : null,
      reason: runs.length
        ? "Retained execution/outcome evidence; completed is not task verification."
        : "No retained outcome evidence.",
    },
  };
}

interface RowContext {
  values: BotState;
  records: Record<string, RoutineRecord>;
  providers: ProviderInfo[] | null;
  observation: HostObservation;
  routineOwners: Map<string, number>;
  now: Date;
}

function modelEvidence(target: AutomationTarget, values: BotState, providers: ProviderInfo[] | null) {
  const resolution = resolveBot(values, target.bot, {
    routineId: target.routine.id,
    providers,
    capabilities: providers ? snapshotCapabilities(providers, null) : undefined,
  });
  const issues = selectionIssues(resolution, providers);
  const provider = providers?.find((entry) => entry.id === resolution.provider.value);
  const selectedModel = resolution.model.value ?? (provider ? defaultModelId(provider.models) : null);
  const stale = issues.some((issue) => issue.field === "model" || issue.code === "provider_unresolved");
  return {
    resolution,
    selectedModel,
    selectionReason: resolution.model.value
      ? `Explicit configured model from ${resolution.model.source.layer}; immutable admitted selections are in run details.`
      : "Provider-default selection from the current selectable model snapshot; immutable admitted selections are in run details.",
    selectionIssues: [...resolution.issues, ...issues],
    stale: {
      value: providers ? stale : null,
      reason: providers
        ? "Compared configured selection with the current selectable host model snapshot."
        : "Provider/model evidence unavailable.",
    },
  };
}

function catalogRow(target: AutomationTarget, context: RowContext): AutomationRow {
  const { bot, routine } = target;
  const { values, providers, observation } = context;
  const record = context.records[routine.id];
  const runs = ledgerRuns(target, record, context.routineOwners);
  const { permission, unknown, ...evidence } = runEvidence(
    runs,
    observation.agents.filter((agent) => agent.botId === bot.id && agent.routineId === routine.id),
    observation.complete,
  );
  const { stale, ...model } = modelEvidence(target, values, providers);
  const team = teamOf(bot.id, values.groups ?? []);
  return {
    id: target.id,
    botId: bot.id,
    botName: bot.name,
    routineId: routine.id,
    routineName: routine.name,
    teamId: team?.id ?? null,
    teamName: team?.name ?? null,
    enabled: routine.enabled,
    executionMode: bot.executionMode ?? "legacy",
    schedule: scheduleProjection(
      routine,
      ownedScheduleRecord(record, runs, context.routineOwners.get(routine.id)),
      context.now,
    ),
    ...evidence,
    ...model,
    attention: {
      permission_requests: permission,
      unknown_outcomes: unknown,
      stale_models: stale,
      memory_failure: { value: null, reason: "No structured memory-failure producer is available." },
      budget_exhaustion: { value: null, reason: "No measured budget-exhaustion producer is available." },
    },
    spendUsd: null,
    escalationCount: null,
    unavailable: [
      "Spend unavailable: no usage accounting producer.",
      "Escalation count unavailable: no routing evidence producer.",
      "Resolved limits are configuration metadata, not proof of enforced dollar/token limits.",
      ...(bot.executionMode === "managed"
        ? []
        : ["Legacy execution: managed accounting and enforcement are not enabled."]),
      ...(evidence.owner ? [] : ["A unique current owner was not observed."]),
      ...(context.routineOwners.get(routine.id) === 1
        ? []
        : ["Legacy records with duplicated routine IDs cannot establish bot ownership."]),
    ],
  };
}

function matches(row: AutomationRow, filters: AutomationsFilter): boolean {
  const fields: [string | boolean | undefined, string | boolean | null][] = [
    [filters.botId, row.botId],
    [filters.teamId, row.teamId],
    [filters.provider, row.resolution.provider.value],
    [filters.model, row.selectedModel],
    [filters.enabled, row.enabled],
  ];
  return (
    fields.every(([expected, actual]) => expected === undefined || expected === actual) &&
    (filters.attention === undefined || row.attention[filters.attention].value === true)
  );
}

const CursorSchema = z.strictObject({
  version: z.literal(1),
  revision: z.string(),
  filters: z.string(),
  after: z.string(),
});

export async function listAutomations(
  host: BotsHost,
  coordinator: Pick<RunCoordinator, "store" | "readiness">,
  input: RpcInput<typeof automationsListRpc>,
  now = new Date(),
): Promise<z.output<typeof automationsListRpc.output>> {
  const { cursor, limit = 50, ...filters } = automationsListRpc.input.parse(input);
  const [snapshot, history, { providers }, observation] = await Promise.all([
    host.store.read(),
    coordinator.store.read(),
    hostProviders(host),
    observeHost(host),
  ]);
  const targets = automationTargets(snapshot.values);
  const routineOwners = new Map<string, number>();
  for (const { routine } of targets.values())
    routineOwners.set(routine.id, (routineOwners.get(routine.id) ?? 0) + 1);
  const context: RowContext = {
    values: snapshot.values,
    records: history.routines,
    providers,
    observation,
    routineOwners,
    now,
  };
  const rows = [...targets.values()]
    .map((target) => catalogRow(target, context))
    .filter((row) => matches(row, filters))
    .sort((a, b) => a.id.localeCompare(b.id));
  const page = paginateRows(rows, {
    cursor,
    limit,
    revision: snapshot.revision,
    filterHash: automationHash(filters),
  });
  return {
    revision: snapshot.revision,
    ...page,
    readiness: coordinator.readiness,
    observedAt: now.toISOString(),
  };
}

function paginateRows(
  rows: AutomationRow[],
  {
    cursor,
    limit,
    revision,
    filterHash,
  }: { cursor: string | undefined; limit: number; revision: string; filterHash: string },
) {
  let start = 0;
  if (cursor !== undefined) {
    let decoded: z.infer<typeof CursorSchema>;
    try {
      decoded = CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    } catch {
      throw new Error("Invalid Automations cursor. Reload the first page.");
    }
    if (decoded.revision !== revision || decoded.filters !== filterHash)
      throw new Error("Automations configuration or filters changed. Reload the first page.");
    const previous = rows.findIndex((row) => row.id === decoded.after);
    if (previous === -1)
      throw new Error("The Automations cursor is no longer in this result. Reload the first page.");
    start = previous + 1;
  }
  const page = rows.slice(start, start + limit);
  const last = page.at(-1);
  const next =
    last && start + page.length < rows.length
      ? Buffer.from(JSON.stringify({ version: 1, revision, filters: filterHash, after: last.id })).toString(
          "base64url",
        )
      : null;
  return { rows: page, cursor: next };
}
