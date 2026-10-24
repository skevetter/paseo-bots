import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { Text, View } from "react-native";
import {
  type AutomationChangeRequest,
  type AutomationReceipt,
  automationsApplyRpc,
  automationsPreviewRpc,
  automationsRevertRpc,
} from "../../shared/automations";
import { newUuid } from "../../shared/uuid";
import { errorText } from "../native";
import { Button } from "../panel/controls";
import {
  AUTOMATIONS_KEY,
  type CatalogChangeEvent,
  type CatalogChangeState,
  type CatalogRevertState,
  catalogApplyBody,
  catalogChange,
  catalogRevertRequest,
  INITIAL_CATALOG_CHANGE,
  INITIAL_CATALOG_REVERT,
} from "./catalog-state";

type Colors = PluginTheme["colors"];
const CHANGE_KEY = [...AUTOMATIONS_KEY, "review-session"] as const;
const REVERT_LOCK_KEY = [...AUTOMATIONS_KEY, "revert-lock"] as const;
export interface CatalogWorkflow {
  state: CatalogChangeState;
  revertLocked: boolean;
  preview(request: AutomationChangeRequest): Promise<void>;
  apply(): Promise<void>;
  close(): void;
  refreshed(): void;
  requireRefresh(): void;
  lockRevert(locked: boolean): void;
}
export function useCatalogChanges(onChanged: () => void): CatalogWorkflow {
  const previewRpc = useRpc(automationsPreviewRpc);
  const applyRpc = useRpc(automationsApplyRpc);
  const queryClient = useQueryClient();
  const { data: state } = useQuery({
    queryKey: CHANGE_KEY,
    queryFn: () => INITIAL_CATALOG_CHANGE,
    initialData: INITIAL_CATALOG_CHANGE,
    enabled: false,
    gcTime: Infinity,
  });
  const current = useRef(state);
  current.current = state;
  const { data: revertLocked } = useQuery({
    queryKey: REVERT_LOCK_KEY,
    queryFn: () => false,
    initialData: false,
    enabled: false,
    gcTime: Infinity,
  });
  const lockRevert = (locked: boolean) => {
    queryClient.setQueryData(REVERT_LOCK_KEY, locked);
  };
  const send = (event: CatalogChangeEvent) => {
    const latest = queryClient.getQueryData<CatalogChangeState>(CHANGE_KEY) ?? INITIAL_CATALOG_CHANGE;
    current.current = catalogChange(latest, event);
    queryClient.setQueryData(CHANGE_KEY, current.current);
  };
  const preview = async (request: AutomationChangeRequest) => {
    if (
      queryClient.getQueryData<boolean>(REVERT_LOCK_KEY) ||
      current.current.needsRefresh ||
      current.current.phase === "applying" ||
      current.current.phase === "uncertain"
    )
      return;
    send({ type: "begin", request });
    const generation = current.current.generation;
    const frozen = current.current.request;
    if (!frozen) return;
    try {
      const result = await previewRpc(frozen);
      send({ type: "preview", generation, result });
    } catch (error) {
      send({ type: "preview-error", generation, error: errorText(error) });
    }
  };
  const apply = async () => {
    if (current.current.phase !== "review" && current.current.phase !== "uncertain") return;
    const body = catalogApplyBody(current.current);
    send({ type: "applying" });
    try {
      const result = await applyRpc(body);
      send({ type: "apply", result });
    } catch (error) {
      send({ type: "apply-error", error: errorText(error) });
    } finally {
      onChanged();
    }
  };
  return {
    state,
    preview,
    apply,
    revertLocked,
    lockRevert,
    close: () => {
      if (!queryClient.getQueryData<boolean>(REVERT_LOCK_KEY)) send({ type: "close" });
    },
    refreshed: () => send({ type: "refreshed" }),
    requireRefresh: () => send({ type: "require-refresh" }),
  };
}

export function CatalogChanges({
  colors,
  workflow,
  revision,
  onChanged,
}: {
  colors: Colors;
  workflow: CatalogWorkflow;
  revision: string | null;
  onChanged(): void;
}) {
  const { state } = workflow;
  if (state.phase === "idle") return null;
  return (
    <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 18 }}>
        {state.request?.enabled ? "Resume" : "Pause"} exact routines: {state.request?.targetIds.length}
      </Text>
      <Text selectable style={{ color: colors.foregroundMuted }}>
        Operation: {state.request?.operationId}; revision: {state.request?.revision}
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>
        Active runs are unaffected. This review is frozen; later selection or filter changes do not change its
        targets.
      </Text>
      {state.phase === "previewing" ? (
        <Text style={{ color: colors.foreground }}>Preparing preview...</Text>
      ) : null}
      {state.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
          {state.error}
        </Text>
      ) : null}
      {state.preview?.warnings.map((warning) => (
        <Text key={warning} style={{ color: colors.foregroundMuted }}>
          {warning}
        </Text>
      ))}
      {state.preview ? <PreviewRows colors={colors} preview={state.preview} /> : null}
      <ReviewActions colors={colors} workflow={workflow} />
      {state.receipt ? (
        <CatalogReceipt
          key={state.receipt.operationId}
          colors={colors}
          receipt={state.receipt}
          revision={revision}
          onChanged={onChanged}
          lockRevert={workflow.lockRevert}
          requireRefresh={workflow.requireRefresh}
          needsRefresh={state.needsRefresh}
        />
      ) : null}
    </View>
  );
}
function ReviewActions({ colors, workflow }: { colors: Colors; workflow: CatalogWorkflow }) {
  const { state } = workflow;
  const unresolved = state.phase === "uncertain";
  const compatible =
    !!state.preview?.compatible && state.preview.rows.every((row) => row.incompatibilities.length === 0);
  const canShowApply = state.phase === "review" || unresolved || state.phase === "applying";
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {canShowApply ? (
        <Button
          colors={colors}
          label={unresolved ? "Retry exact apply / recover receipt" : "Apply reviewed changes"}
          loading={state.phase === "applying"}
          disabled={!compatible}
          onPress={() => void workflow.apply()}
        />
      ) : null}
      <Button
        colors={colors}
        label="Close review"
        disabled={state.phase === "applying" || unresolved || workflow.revertLocked || state.needsRefresh}
        onPress={workflow.close}
      />
    </View>
  );
}
function PreviewRows({
  colors,
  preview,
}: {
  colors: Colors;
  preview: NonNullable<CatalogChangeState["preview"]>;
}) {
  return (
    <View style={{ gap: 8 }}>
      {preview.rows.map((row) => (
        <View key={row.id} style={{ gap: 4, paddingVertical: 8 }}>
          <Text selectable style={{ color: colors.foreground }}>
            {row.botName} ({row.botId}) / {row.routineName} ({row.routineId})
          </Text>
          <Text selectable style={{ color: colors.foregroundMuted }}>
            Target: {row.id}; enabled: {String(row.beforeEnabled)} to {String(row.afterEnabled)}
          </Text>
          <Text style={{ color: colors.foregroundMuted }}>
            Provider: {row.resolution.provider.value ?? "unresolved"}; model:{" "}
            {row.resolution.model.value ?? "provider default"}
          </Text>
          {row.incompatibilities.map((issue) => (
            <Text
              key={`${issue.code}:${issue.field}:${issue.message}`}
              accessibilityRole="alert"
              style={{ color: colors.statusDanger }}
            >
              {issue.field}: {issue.message} ({issue.code})
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function CatalogReceipt({
  colors,
  receipt,
  revision,
  onChanged,
  lockRevert,
  requireRefresh,
  needsRefresh,
}: {
  colors: Colors;
  receipt: AutomationReceipt;
  revision: string | null;
  onChanged(): void;
  lockRevert(locked: boolean): void;
  requireRefresh(): void;
  needsRefresh: boolean;
}) {
  const revertRpc = useRpc(automationsRevertRpc);
  const queryClient = useQueryClient();
  const key = [...AUTOMATIONS_KEY, "revert-session", receipt.operationId];
  const { data: state } = useQuery({
    queryKey: key,
    queryFn: () => INITIAL_CATALOG_REVERT,
    initialData: INITIAL_CATALOG_REVERT,
    enabled: false,
    gcTime: Infinity,
  });
  const current = useRef(state);
  current.current = state;
  const update = (next: CatalogRevertState) => {
    current.current = next;
    queryClient.setQueryData(key, next);
  };
  const revert = async () => {
    if (!revision || current.current.phase === "pending" || current.current.phase === "done") return;
    const request = catalogRevertRequest(current.current, {
      operationId: newUuid(),
      revision,
      appliedOperationId: receipt.operationId,
    });
    update({ ...current.current, request, phase: "pending", error: null });
    lockRevert(true);
    try {
      const result = await revertRpc(request);
      if (result.status === "conflict") {
        requireRefresh();
        update({
          ...current.current,
          phase: "conflict",
          error: `${result.error} Refresh catalog before explicitly requesting another revert.`,
        });
        lockRevert(false);
      } else {
        update({ ...current.current, phase: "done", receipt: result.receipt, error: null });
        lockRevert(false);
      }
    } catch (error) {
      update({
        ...current.current,
        phase: "uncertain",
        error: `${errorText(error)} Revert outcome unknown; retry the same request to recover its receipt.`,
      });
    } finally {
      onChanged();
    }
  };
  return (
    <View style={{ gap: 6 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground }}>
        Applied receipt
      </Text>
      <ReceiptFacts colors={colors} receipt={receipt} />
      <Text style={{ color: colors.foregroundMuted }}>
        Revert changes only the reviewed enabled values and refuses intervening routine edits. It does not
        stop active runs.
      </Text>
      {state.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
          {state.error}
        </Text>
      ) : null}
      {state.receipt ? (
        <ReceiptFacts colors={colors} receipt={state.receipt} />
      ) : (
        <Button
          colors={colors}
          label={
            state.phase === "uncertain" ? "Retry exact revert / recover receipt" : "Revert this operation"
          }
          loading={state.phase === "pending"}
          disabled={!revision || (state.phase === "conflict" && needsRefresh)}
          onPress={() => void revert()}
        />
      )}
    </View>
  );
}
function ReceiptFacts({ colors, receipt }: { colors: Colors; receipt: AutomationReceipt }) {
  return (
    <View style={{ gap: 4 }}>
      <Text selectable style={{ color: colors.foregroundMuted }}>
        Operation: {receipt.operationId}; applied: {receipt.appliedAt}; body hash: {receipt.bodyHash}
      </Text>
      <Text selectable style={{ color: colors.foregroundMuted }}>
        Revision: {receipt.originalRevision} to {receipt.newRevision}
      </Text>
      {receipt.automations.rows.map((row) => (
        <Text key={row.targetId} selectable style={{ color: colors.foregroundMuted }}>
          {row.targetId}: {String(row.before)} to {String(row.after)}; hash: {row.afterHash}
        </Text>
      ))}
      {receipt.notes.map((note) => (
        <Text key={note} style={{ color: colors.foregroundMuted }}>
          {note}
        </Text>
      ))}
    </View>
  );
}
