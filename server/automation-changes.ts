import type { RpcInput } from "@getpaseo/plugin";
import type { z } from "zod";
import {
  type AutomationApplyResult,
  type AutomationChangeRequest,
  AutomationChangeRequestSchema,
  type AutomationPreview,
  type AutomationPreviewRow,
  AutomationReceiptSchema,
  automationsApplyRpc,
  type automationsPreviewRpc,
  automationsRevertRpc,
} from "../shared/automations";
import type { BotState, StateSnapshot } from "../shared/bot";
import type { ProviderInfo } from "../shared/changes/context";
import { findReceipt, type OperationChange } from "../shared/changes/operation";
import { type Issue, resolveBot, snapshotCapabilities } from "../shared/policies";
import { hostProviders } from "./apply-context";
import { type AutomationTarget, automationHash, automationTargets } from "./automation-targets";
import type { BotsHost } from "./host";
import { selectionIssues } from "./policy-selection";
import type { OperationResult } from "./state";

function requireRevision(actual: string | undefined, expected: string): void {
  if (actual !== expected)
    throw new Error("Bots changed elsewhere. Reload and preview the exact routines again.");
}

function conflict(error: unknown): { status: "conflict"; error: string } {
  return { status: "conflict", error: error instanceof Error ? error.message : String(error) };
}

function previewRow(
  values: BotState,
  target: AutomationTarget,
  enabled: boolean,
  providers: ProviderInfo[] | null,
): AutomationPreviewRow {
  const { id, bot, routine } = target;
  const resolution = resolveBot(values, bot, {
    routineId: routine.id,
    providers,
    capabilities: providers ? snapshotCapabilities(providers, null) : undefined,
  });
  const incompatibilities: Issue[] = enabled
    ? [...resolution.issues, ...selectionIssues(resolution, providers)]
    : [];
  if (enabled && bot.hostId)
    incompatibilities.push({
      code: "provider_unresolved",
      field: "hostId",
      message: "This routine belongs to a remote bot and cannot execute on the storing host.",
    });
  return {
    id,
    botId: bot.id,
    botName: bot.name,
    routineId: routine.id,
    routineName: routine.name,
    beforeEnabled: routine.enabled,
    afterEnabled: enabled,
    routineHash: automationHash(routine),
    resolution,
    incompatibilities,
  };
}

function buildPreview(
  snapshot: StateSnapshot,
  request: AutomationChangeRequest,
  providers: ProviderInfo[] | null,
): AutomationPreview {
  requireRevision(snapshot.revision, request.revision);
  const targets = automationTargets(snapshot.values);
  const rows = request.targetIds.map((id) => {
    const target = targets.get(id);
    if (!target) throw new Error(`Routine target ${id} no longer exists. No routines were changed.`);
    return previewRow(snapshot.values, target, request.enabled, providers);
  });
  return {
    request,
    digest: automationHash({ request, rows, providers: request.enabled ? providers : null }),
    rows,
    compatible: rows.every((row) => row.incompatibilities.length === 0),
    activeRunsUnaffected: true,
    warnings: [
      "Only these exact routines change. Active runs and unknown external effects are not canceled or restarted.",
      "Resuming permits future scheduled occurrences; it does not retry a previous run.",
    ],
  };
}

export async function previewAutomationChange(
  host: BotsHost,
  input: AutomationChangeRequest,
): Promise<z.output<typeof automationsPreviewRpc.output>> {
  try {
    const request = AutomationChangeRequestSchema.parse(input);
    const snapshot = await host.store.read();
    const { providers } = await hostProviders(host);
    return { status: "previewed", preview: buildPreview(snapshot, request, providers) };
  } catch (error) {
    return conflict(error);
  }
}

function changedValues(
  values: BotState,
  rows: AutomationPreviewRow[],
  now: string,
  appliedOperationId?: string,
): OperationChange {
  const targets = automationTargets(values);
  const routineChanges = new Map<string, Map<string, boolean>>();
  const audit = rows.map((row) => {
    const target = targets.get(row.id);
    if (!target) throw new Error(`Routine target ${row.id} no longer exists.`);
    const perBot = routineChanges.get(row.botId) ?? new Map<string, boolean>();
    perBot.set(row.routineId, row.afterEnabled);
    routineChanges.set(row.botId, perBot);
    return {
      targetId: row.id,
      botId: row.botId,
      routineId: row.routineId,
      before: row.beforeEnabled,
      after: row.afterEnabled,
      afterHash: automationHash({ ...target.routine, enabled: row.afterEnabled }),
    };
  });
  return {
    values: {
      ...values,
      bots: values.bots.map((bot) => {
        const perBot = routineChanges.get(bot.id);
        return perBot
          ? {
              ...bot,
              updatedAt: now,
              routines: bot.routines.map((routine) =>
                perBot.has(routine.id)
                  ? { ...routine, enabled: perBot.get(routine.id) ?? routine.enabled }
                  : routine,
              ),
            }
          : bot;
      }),
    },
    automations: { rows: audit, ...(appliedOperationId ? { appliedOperationId } : {}) },
  };
}

function applied(result: OperationResult): AutomationApplyResult {
  return {
    status: result.status,
    receipt: AutomationReceiptSchema.parse(result.receipt),
    revision: result.snapshot.revision,
  };
}

export async function applyAutomationChange(
  host: BotsHost,
  input: RpcInput<typeof automationsApplyRpc>,
): Promise<AutomationApplyResult> {
  try {
    const body = automationsApplyRpc.input.parse(input);
    const result = await host.store.apply(
      {
        id: body.request.operationId,
        kind: "automations.change",
        bodyHash: automationHash(body),
        at: new Date().toISOString(),
      },
      async (values, scope) => {
        requireRevision(scope.revision, body.request.revision);
        const { providers } = await hostProviders(host);
        const preview = buildPreview({ values, revision: body.request.revision }, body.request, providers);
        if (preview.digest !== body.previewDigest)
          throw new Error(
            "Preview digest no longer matches the request, configuration or provider evidence. Reload and preview again.",
          );
        if (!preview.compatible)
          throw new Error(
            "Some selected routines cannot be resumed with their current execution settings. No routines were changed.",
          );
        return changedValues(values, preview.rows, scope.now);
      },
    );
    return applied(result);
  } catch (error) {
    return conflict(error);
  }
}

export async function revertAutomationChange(
  host: BotsHost,
  input: RpcInput<typeof automationsRevertRpc>,
): Promise<AutomationApplyResult> {
  try {
    const body = automationsRevertRpc.input.parse(input);
    const result = await host.store.apply(
      {
        id: body.operationId,
        kind: "automations.revert",
        bodyHash: automationHash(body),
        at: new Date().toISOString(),
      },
      async (values, scope) => {
        requireRevision(scope.revision, body.revision);
        const receipt = findReceipt(values, body.appliedOperationId);
        if (receipt?.kind !== "automations.change" || !receipt.automations)
          throw new Error("The applied routine receipt is unavailable or cannot be reverted.");
        const targets = automationTargets(values);
        const { providers } = await hostProviders(host);
        const rows = receipt.automations.rows.map((audit) => {
          const target = targets.get(audit.targetId);
          if (
            !target ||
            target.bot.id !== audit.botId ||
            target.routine.id !== audit.routineId ||
            automationHash(target.routine) !== audit.afterHash
          )
            throw new Error(
              `Routine target ${audit.targetId} changed after this operation. No routines were reverted.`,
            );
          const row = previewRow(values, target, audit.before, providers);
          if (row.incompatibilities.length)
            throw new Error(row.incompatibilities.map((issue) => issue.message).join(" "));
          return row;
        });
        return changedValues(values, rows, scope.now, body.appliedOperationId);
      },
    );
    return applied(result);
  } catch (error) {
    return conflict(error);
  }
}
