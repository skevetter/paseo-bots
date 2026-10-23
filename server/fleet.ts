import { createHash } from "node:crypto";
import { BOT_LABEL, type Bot, type BotState, type StateSnapshot } from "../shared/bot";
import type { ProviderInfo } from "../shared/changes/context";
import { findReceipt, type OperationChange } from "../shared/changes/operation";
import { type FleetSettings, FleetSettingsSchema } from "../shared/changes/receipt";
import {
  type FleetApplyResult,
  type FleetChangeRequest,
  FleetChangeRequestSchema,
  type FleetPreview,
  type FleetPreviewRow,
  FleetReceiptSchema,
  type FleetRow,
  fleetApplyRpc,
  fleetRevertRpc,
} from "../shared/fleet";
import { teamOf } from "../shared/groups";
import {
  currentPolicies,
  patchBotOverrides,
  resolveBot,
  snapshotCapabilities,
  unsetOverrides,
  validateProviderTransition,
} from "../shared/policies";
import type { RoutineRecord } from "../shared/rpc";
import { hostProviders } from "./apply-context";
import type { BotsHost } from "./host";
import { selectionIssues } from "./policy-selection";
import type { OperationResult } from "./state";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const conflict = (error: unknown): { status: "conflict"; error: string } => ({
  status: "conflict",
  error: error instanceof Error ? error.message : String(error),
});

function requireRevision(actual: string | undefined, expected: string): void {
  if (actual !== expected) throw new Error("Bots changed elsewhere. Reload and preview again.");
}

function patched(bot: Bot, request: FleetChangeRequest): Bot {
  const { binding, ...overrides } = request.patch;
  let next = patchBotOverrides(bot, overrides);
  if (binding !== undefined) next = { ...next, policy: { binding, inherit: next.policy?.inherit ?? [] } };
  return request.unset.length ? unsetOverrides(next, request.unset) : next;
}

function previewRow(input: {
  values: BotState;
  bot: Bot;
  request: FleetChangeRequest;
  providers: ProviderInfo[] | null;
}): FleetPreviewRow {
  const { values, bot, request, providers } = input;
  // No wall-clock timestamp: identical host evidence must yield identical preview identity.
  const options = { providers, capabilities: providers ? snapshotCapabilities(providers, null) : undefined };
  const after = patched(bot, request);
  const beforeResolution = resolveBot(values, bot, options);
  const afterResolution = resolveBot(values, after, options);
  const target = afterResolution.provider.value;
  const transition = target
    ? validateProviderTransition(
        {
          ...bot,
          provider: beforeResolution.provider.value ?? bot.provider,
          modeId: beforeResolution.modeId.value,
        },
        target,
        providers,
      )
    : [];
  const incompatibilities = [
    ...afterResolution.issues,
    ...selectionIssues(afterResolution, providers),
    ...transition,
  ];
  return {
    botId: bot.id,
    name: bot.name,
    before: bot,
    after,
    beforeResolution,
    afterResolution,
    incompatibilities,
  };
}

function buildPreview(
  snapshot: StateSnapshot,
  request: FleetChangeRequest,
  providers: ProviderInfo[] | null,
): FleetPreview {
  requireRevision(snapshot.revision, request.revision);
  const bots = new Map(snapshot.values.bots.map((bot) => [bot.id, bot]));
  const rows = request.botIds.map((id) => {
    const bot = bots.get(id);
    if (!bot) throw new Error(`Bot ${id} no longer exists. Select exact bot IDs and preview again.`);
    return previewRow({ values: snapshot.values, bot, request, providers });
  });
  return {
    request,
    digest: hash({ request, values: snapshot.values, rows, providers }),
    rows,
    warnings: ["Active chats keep their existing settings; this changes future chats and runs only."],
    activeChatsUnaffected: true,
    compatible: rows.every((row) => row.incompatibilities.length === 0),
  };
}

export async function previewFleetChange(host: BotsHost, input: FleetChangeRequest) {
  try {
    const request = FleetChangeRequestSchema.parse(input);
    const snapshot = await host.store.read();
    const { providers } = await hostProviders(host);
    return { status: "previewed" as const, preview: buildPreview(snapshot, request, providers) };
  } catch (error) {
    return conflict(error);
  }
}

function changedValues(values: BotState, rows: FleetPreviewRow[], now: string): OperationChange {
  const changed = new Map(rows.map((row) => [row.botId, { ...row.after, updatedAt: now }]));
  return {
    values: { ...values, bots: values.bots.map((bot) => changed.get(bot.id) ?? bot) },
    fleet: {
      rows: rows.map((row) => {
        const after = changed.get(row.botId) ?? row.after;
        return {
          botId: row.botId,
          before: FleetSettingsSchema.parse(row.before),
          after: FleetSettingsSchema.parse(after),
          afterHash: hash(after),
        };
      }),
    },
  };
}

function applied(result: OperationResult): FleetApplyResult {
  return {
    status: result.status,
    receipt: FleetReceiptSchema.parse(result.receipt),
    revision: result.snapshot.revision,
  };
}

/** Optional control-boundary authorization is evaluated inside the same serialized transition. */
export type FleetAuthorize = (rows: readonly FleetPreviewRow[]) => void | Promise<void>;

export async function applyFleetChange(
  host: BotsHost,
  input: typeof fleetApplyRpc.input._output,
  authorize?: FleetAuthorize,
): Promise<FleetApplyResult> {
  try {
    const body = fleetApplyRpc.input.parse(input);
    const result = await host.store.apply(
      {
        id: body.request.operationId,
        kind: "fleet.change",
        bodyHash: hash(body),
        at: new Date().toISOString(),
      },
      async (values, scope) => {
        requireRevision(scope.revision, body.request.revision);
        const { providers } = await hostProviders(host);
        const preview = buildPreview({ values, revision: body.request.revision }, body.request, providers);
        if (preview.digest !== body.previewDigest)
          throw new Error(
            "Preview digest no longer matches the request, configuration or host evidence. Preview again.",
          );
        if (!preview.compatible)
          throw new Error("Some selected bots have incompatible execution settings. No bots were changed.");
        await authorize?.(preview.rows);
        return changedValues(values, preview.rows, scope.now);
      },
    );
    return applied(result);
  } catch (error) {
    return conflict(error);
  }
}

function restored(bot: Bot, settings: FleetSettings): Bot {
  const { policy: _policy, ...rest } = bot;
  return { ...rest, ...settings };
}

function revertRows(values: BotState, operationId: string): FleetPreviewRow[] {
  const receipt = findReceipt(values, operationId);
  if (!receipt?.fleet || receipt.kind !== "fleet.change")
    throw new Error("The applied fleet receipt is unavailable or cannot be reverted.");
  return receipt.fleet.rows.map((row) => {
    const bot = values.bots.find((entry) => entry.id === row.botId);
    if (!bot || hash(bot) !== row.afterHash)
      throw new Error(`Bot ${row.botId} changed after the operation. Revert refused; no bots changed.`);
    const after = restored(bot, row.before);
    return {
      botId: bot.id,
      name: bot.name,
      before: bot,
      after,
      beforeResolution: resolveBot(values, bot),
      afterResolution: resolveBot(values, after),
      incompatibilities: [],
    };
  });
}
function qualifyRevert(values: BotState, row: FleetPreviewRow, providers: ProviderInfo[] | null): void {
  const options = { providers, capabilities: providers ? snapshotCapabilities(providers, null) : undefined };
  row.beforeResolution = resolveBot(values, row.before, options);
  row.afterResolution = resolveBot(values, row.after, options);
  const target = row.afterResolution.provider.value;
  const transition = target
    ? validateProviderTransition(
        {
          ...row.before,
          provider: row.beforeResolution.provider.value ?? row.before.provider,
          modeId: row.beforeResolution.modeId.value,
        },
        target,
        providers,
      )
    : [];
  const issues = [
    ...row.afterResolution.issues,
    ...selectionIssues(row.afterResolution, providers),
    ...transition,
  ];
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join(" "));
}

export async function revertFleetChange(
  host: BotsHost,
  input: typeof fleetRevertRpc.input._output,
  authorize?: FleetAuthorize,
): Promise<FleetApplyResult> {
  try {
    const body = fleetRevertRpc.input.parse(input);
    const result = await host.store.apply(
      { id: body.operationId, kind: "fleet.revert", bodyHash: hash(body), at: new Date().toISOString() },
      async (values, scope) => {
        requireRevision(scope.revision, body.revision);
        const rows = revertRows(values, body.appliedOperationId);
        const { providers } = await hostProviders(host);
        // Reverting also preserves the current permission envelope under current host evidence.
        for (const row of rows) qualifyRevert(values, row, providers);
        await authorize?.(rows);
        const change = changedValues(values, rows, scope.now);
        if (change.fleet) change.fleet.appliedOperationId = body.appliedOperationId;
        return change;
      },
    );
    return applied(result);
  } catch (error) {
    return conflict(error);
  }
}

async function activeCounts(host: BotsHost): Promise<Map<string, number> | null> {
  if (!host.paseo) return null;
  try {
    const snapshot = await host.paseo.agents.list();
    // A partial list cannot establish zero active work for bots absent from this page.
    if (snapshot.pageInfo.hasMore) return null;
    const counts = new Map<string, number>();
    for (const { agent } of snapshot.entries) {
      const botId = agent.labels?.[BOT_LABEL];
      if (botId && !agent.archivedAt && (agent.status === "running" || agent.status === "initializing"))
        counts.set(botId, (counts.get(botId) ?? 0) + 1);
    }
    return counts;
  } catch {
    return null;
  }
}

function latestRun(bot: Bot, routines: Record<string, RoutineRecord>) {
  let latest: RoutineRecord["runs"][number] | undefined;
  for (const routine of bot.routines)
    for (const run of routines[routine.id]?.runs ?? [])
      if (!latest || Date.parse(run.startedAt) > Date.parse(latest.startedAt)) latest = run;
  return latest;
}

export async function listFleet(host: BotsHost, routines: Record<string, RoutineRecord> = {}) {
  const snapshot = await host.store.read();
  const [{ providers }, counts] = await Promise.all([hostProviders(host), activeCounts(host)]);
  const options = { providers, capabilities: providers ? snapshotCapabilities(providers, null) : undefined };
  const unavailable = [
    ...(!providers ? ["Host provider evidence unavailable."] : []),
    ...(counts ? [] : ["Active work unavailable: host agents snapshot is unavailable or incomplete."]),
    "Spend unavailable: usage accounting is not available.",
  ];
  const rows: FleetRow[] = snapshot.values.bots.map((bot) => {
    const resolution = resolveBot(snapshot.values, bot, options);
    const team = teamOf(bot.id, snapshot.values.groups ?? []);
    const latest = latestRun(bot, routines);
    return {
      bot,
      resolution,
      teamId: team?.id ?? null,
      teamName: team?.name ?? null,
      lastOutcome: latest?.taskOutcome ?? "unknown",
      executionStatus: latest?.executionStatus ?? null,
      activeWork: counts ? (counts.get(bot.id) ?? 0) : null,
      spendUsd: null,
      attention: [...resolution.issues.map((issue) => issue.message), ...unavailable],
    };
  });
  return { revision: snapshot.revision, rows, policies: currentPolicies(snapshot.values.policies ?? []) };
}
