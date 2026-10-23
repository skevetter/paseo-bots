import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import { useReducer, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  type FleetChangeRequest,
  type FleetPreviewRow,
  type FleetReceipt,
  fleetApplyRpc,
  fleetPreviewRpc,
  fleetRevertRpc,
} from "../../shared/fleet";
import { closeInheritance, type Inheritable, type Policy } from "../../shared/policies";
import { newUuid } from "../../shared/uuid";
import { errorText } from "../native";
import { Button } from "../panel/controls";
import { InputField } from "../panel/fields";
import { applyPreview, bulkState, freezeRequest, INITIAL_BULK_STATE } from "./bulk-state";

type Colors = PluginTheme["colors"];
type FieldMode = "unchanged" | "inherit" | "default" | "set";
interface Draft {
  binding: string;
  pinned: boolean;
  provider: FieldMode;
  providerValue: string;
  model: FieldMode;
  modelValue: string;
  thinkingOptionId: FieldMode;
  thinkingOptionIdValue: string;
}

const INITIAL_DRAFT: Draft = {
  binding: "",
  pinned: false,
  provider: "unchanged",
  providerValue: "",
  model: "unchanged",
  modelValue: "",
  thinkingOptionId: "unchanged",
  thinkingOptionIdValue: "",
};

export function BulkPolicySheet(props: {
  colors: Colors;
  revision: string;
  botIds: readonly string[];
  policies: readonly Policy[];
  initialUnset?: Inheritable[];
  onClose(): void;
  onChanged(): void;
  onRefresh(): void;
}) {
  const { colors } = props;
  const [targets] = useState(() => [...props.botIds]);
  const [draft, setDraft] = useState<Draft>(() => ({
    ...INITIAL_DRAFT,
    ...Object.fromEntries((props.initialUnset ?? []).map((field) => [field, "inherit"])),
  }));
  const workflow = useBulkWorkflow(props.onChanged);
  const edit = (patch: Partial<Draft>) => {
    if (workflow.apply.isPending || workflow.revert.isPending) return;
    workflow.edit();
    setDraft((current) => ({ ...current, ...patch }));
  };
  const preview = () => {
    try {
      workflow.startPreview(
        buildRequest({ draft, targets, revision: props.revision, policies: props.policies }),
      );
    } catch (error) {
      workflow.fail(errorText(error));
    }
  };
  const busy = workflow.preview.isPending || workflow.apply.isPending || workflow.revert.isPending;
  return (
    <Modal title="Bulk runtime policy" open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 16 }}>
        <Text style={{ color: colors.foreground }}>
          Exact targets ({targets.length}): {targets.join(", ")}
        </Text>
        <Text style={{ color: colors.foregroundMuted }}>
          Only future chats and runs use these settings. Active chats are not edited, canceled or restarted.
          Approval and tool grants are not changed.
        </Text>
        {!workflow.state.receipt ? (
          <>
            <BindingFields draft={draft} policies={props.policies} edit={edit} disabled={busy} />
            <Text style={{ color: colors.foregroundMuted }}>
              Binding a policy keeps explicit bot overrides. Choose Reset to inherited below to adopt policy
              settings. Resetting provider also resets model and thinking; resetting model also resets
              thinking.
            </Text>
            {(["provider", "model", "thinkingOptionId"] as const).map((field) => (
              <ExecutionField
                key={field}
                colors={colors}
                field={field}
                draft={draft}
                edit={edit}
                disabled={busy}
              />
            ))}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button
                colors={colors}
                label="Preview exact changes"
                loading={workflow.preview.isPending}
                disabled={busy}
                onPress={preview}
              />
              <Button
                colors={colors}
                label="Refresh fleet"
                disabled={busy}
                onPress={() => {
                  workflow.edit();
                  props.onRefresh();
                }}
              />
              <Button
                colors={colors}
                label="Apply preview"
                variant="default"
                disabled={busy || !workflow.canApply}
                loading={workflow.apply.isPending}
                onPress={() => workflow.apply.mutate()}
              />
            </View>
          </>
        ) : (
          <ReceiptView
            colors={colors}
            receipt={workflow.state.receipt}
            busy={busy}
            reverted={workflow.reverted}
            onRevert={() =>
              workflow.revert.mutate({
                revision: props.revision,
                appliedOperationId: workflow.state.receipt?.operationId ?? "",
              })
            }
          />
        )}
        {workflow.state.error ? (
          <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
            {workflow.state.error}
          </Text>
        ) : null}
        {workflow.state.preview ? (
          <>
            {!workflow.state.preview.compatible ? (
              <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
                Incompatible target: apply is disabled for the entire selection. No bots changed.
              </Text>
            ) : null}
            {[...new Set(workflow.state.preview.warnings)].map((warning) => (
              <Text key={warning} style={{ color: colors.foregroundMuted }}>
                {warning}
              </Text>
            ))}
            {workflow.state.preview.rows.map((row) => (
              <PreviewRow key={row.botId} colors={colors} row={row} />
            ))}
          </>
        ) : null}
        <Button colors={colors} label="Close" disabled={busy} onPress={props.onClose} />
      </Modal.Content>
    </Modal>
  );
}

function buildRequest(input: {
  draft: Draft;
  targets: string[];
  revision: string;
  policies: readonly Policy[];
}): FleetChangeRequest {
  const { draft } = input;
  const patch = bindingPatch(draft, input.policies);
  const unset = closeInheritance(
    (["provider", "model", "thinkingOptionId"] as const).filter((field) => draft[field] === "inherit"),
  );
  for (const field of ["provider", "model", "thinkingOptionId"] as const) {
    if (draft[field] === "set") patch[field] = draft[`${field}Value`].trim();
    else if (draft[field] === "default") Object.assign(patch, { [field]: null });
  }
  return freezeRequest({
    operationId: newUuid(),
    revision: input.revision,
    botIds: input.targets,
    patch,
    unset,
  });
}

function bindingPatch(draft: Draft, policies: readonly Policy[]): FleetChangeRequest["patch"] {
  if (!draft.binding) return {};
  if (draft.binding === "unbind") return { binding: null };
  const policy = policies.find((entry) => entry.id === draft.binding);
  if (!policy) throw new Error("Selected policy is unavailable. Refresh policies before previewing.");
  return { binding: { policyId: policy.id, revision: draft.pinned ? policy.revision : null } };
}

function useBulkWorkflow(onChanged: () => void) {
  const previewRpc = useRpc(fleetPreviewRpc);
  const applyRpc = useRpc(fleetApplyRpc);
  const revertRpc = useRpc(fleetRevertRpc);
  const [state, dispatch] = useReducer(bulkState, INITIAL_BULK_STATE);
  const [reverted, setReverted] = useState(false);
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const fail = (error: string) => dispatch({ type: "error", error });
  const preview = useMutation({
    retry: false,
    mutationFn: async (input: { request: FleetChangeRequest; generation: number }) => ({
      generation: input.generation,
      result: await previewRpc(input.request),
    }),
    onSuccess: (result) => dispatch({ type: "preview", ...result }),
    onError: (error) => fail(errorText(error)),
  });
  const apply = useMutation({
    retry: false,
    mutationFn: () => applyRpc(applyPreview(stateRef.current)),
    onSuccess: (result) => {
      dispatch({ type: "apply", result });
      if (result.status !== "conflict") onChanged();
    },
    onError: (error) =>
      fail(
        `${errorText(error)} Retry the same preview to recover its receipt; do not create a replacement operation.`,
      ),
  });
  const revertRequest = useRef<{ operationId: string; revision: string; appliedOperationId: string } | null>(
    null,
  );
  const revert = useMutation({
    retry: false,
    mutationFn: (input: { revision: string; appliedOperationId: string }) => {
      if (revertRequest.current?.appliedOperationId !== input.appliedOperationId)
        revertRequest.current = { ...input, operationId: newUuid() };
      return revertRpc(revertRequest.current);
    },
    onSuccess: (result) => {
      if (result.status === "conflict") {
        fail(`${result.error} Refresh fleet and reconcile later edits before explicitly retrying revert.`);
        revertRequest.current = null;
        return;
      }
      dispatch({ type: "apply", result });
      setReverted(true);
      onChanged();
    },
    onError: (error) => fail(errorText(error)),
  });
  return {
    state,
    preview,
    apply,
    revert,
    reverted,
    fail,
    canApply:
      !!state.preview?.compatible &&
      !state.blocked &&
      state.preview.rows.every((row) => row.incompatibilities.length === 0),
    startPreview: (request: FleetChangeRequest) =>
      preview.mutate({ request, generation: generation.current }),
    edit: () => {
      generation.current += 1;
      stateRef.current = bulkState(stateRef.current, { type: "edit" });
      dispatch({ type: "edit" });
    },
  };
}

function BindingFields({
  draft,
  policies,
  edit,
  disabled,
}: {
  draft: Draft;
  policies: readonly Policy[];
  edit(patch: Partial<Draft>): void;
  disabled: boolean;
}) {
  return (
    <SettingsCard>
      <SettingsSelect
        disabled={disabled}
        label="Bot policy binding"
        value={draft.binding}
        options={[
          { label: "Leave unchanged", value: "" },
          { label: "Unbind bot policy (keep team/global)", value: "unbind" },
          ...policies.map((policy) => ({
            label: `${policy.name} (revision ${policy.revision})`,
            value: policy.id,
          })),
        ]}
        onValueChange={(binding) => edit({ binding })}
      />
      <SettingsSwitch
        disabled={disabled}
        label="Pin the displayed policy revision"
        hint="Off follows future revisions; on keeps this immutable revision."
        value={draft.pinned}
        onValueChange={(pinned) => edit({ pinned })}
      />
    </SettingsCard>
  );
}

function ExecutionField({
  colors,
  field,
  draft,
  edit,
  disabled,
}: {
  colors: Colors;
  field: Inheritable;
  draft: Draft;
  edit(patch: Partial<Draft>): void;
  disabled: boolean;
}) {
  const labels = { provider: "Provider", model: "Model", thinkingOptionId: "Thinking option" };
  return (
    <SettingsCard>
      <SettingsSelect
        disabled={disabled}
        label={labels[field]}
        value={draft[field]}
        options={[
          { label: "Leave unchanged", value: "unchanged" },
          { label: "Reset to inherited", value: "inherit" },
          ...(field === "provider" ? [] : [{ label: "Provider default (explicit null)", value: "default" }]),
          { label: "Explicit override", value: "set" },
        ]}
        onValueChange={(value) => edit({ [field]: value })}
      />
      {draft[field] === "set" ? (
        <InputField
          colors={colors}
          disabled={disabled}
          label={`${labels[field]} ID`}
          initialValue={draft[`${field}Value`]}
          onChangeText={(value) => edit({ [`${field}Value`]: value })}
        />
      ) : null}
    </SettingsCard>
  );
}

function PreviewRow({ colors, row }: { colors: Colors; row: FleetPreviewRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ padding: 12, gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
      <Text style={{ color: colors.foreground }}>
        {row.name} ({row.botId})
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>
        Before: {row.beforeResolution.provider.value ?? "unresolved"} /{" "}
        {row.beforeResolution.model.value ?? "provider default"} /{" "}
        {row.beforeResolution.thinkingOptionId.value ?? "provider default"}
      </Text>
      <Text style={{ color: colors.foreground }}>
        After: {row.afterResolution.provider.value ?? "unresolved"} /{" "}
        {row.afterResolution.model.value ?? "provider default"} /{" "}
        {row.afterResolution.thinkingOptionId.value ?? "provider default"}
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
      <Button
        colors={colors}
        label={expanded ? "Hide exact before/after" : "Show exact before/after"}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <Text selectable style={{ color: colors.foreground, fontSize: 12 }}>
          {JSON.stringify(
            {
              before: row.before,
              after: row.after,
              beforeResolution: row.beforeResolution,
              afterResolution: row.afterResolution,
            },
            null,
            2,
          )}
        </Text>
      ) : null}
    </View>
  );
}

function ReceiptView({
  colors,
  receipt,
  busy,
  reverted,
  onRevert,
}: {
  colors: Colors;
  receipt: FleetReceipt;
  busy: boolean;
  reverted: boolean;
  onRevert(): void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground }}>
        {reverted ? "Reverted by operation" : "Applied operation"} {receipt.operationId}
      </Text>
      <Text selectable style={{ color: colors.foregroundMuted }}>
        Revision {receipt.originalRevision} to {receipt.newRevision}
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>
        Revert creates a new audited operation. It refuses if any affected bot was edited later; unrelated
        changes are preserved.
      </Text>
      {[...new Set(receipt.notes)].map((note) => (
        <Text key={note} style={{ color: colors.foregroundMuted }}>
          {note}
        </Text>
      ))}
      {!reverted ? (
        <Button colors={colors} label="Revert this operation" disabled={busy} onPress={onRevert} />
      ) : null}
    </View>
  );
}
