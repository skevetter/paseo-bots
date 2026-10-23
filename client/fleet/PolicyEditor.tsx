import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useReducer, useState } from "react";
import { Text, View } from "react-native";
import type { Policy } from "../../shared/policies";
import { policiesDeleteRpc, policiesGetRpc, policiesListRpc, policiesSaveRpc } from "../../shared/rpc";
import { errorText } from "../native";
import { Button } from "../panel/controls";
import { InputField, TextAreaField } from "../panel/fields";
import { ui } from "../typography";
import {
  createPolicyEditor,
  type PolicyEditorAction,
  type PolicyEditorState,
  parsePolicyDraft,
  policyEditorReducer,
  policyReferrerLabel,
} from "./policy-editor";

type Colors = PluginTheme["colors"];
const POLICIES_KEY = ["paseo-bots", "policies"] as const;

interface PolicyEditorProps {
  colors: Colors;
  onClose(): void;
  onChanged(): void;
}

type PolicySnapshot = { revision: string; policies: Policy[] };
type SavedPolicy = { revision: string; policy: Policy };
type DeletedPolicy = { revision: string; id: string };

export function PolicyEditor({ colors, onClose, onChanged }: PolicyEditorProps) {
  const list = useRpc(policiesListRpc);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: POLICIES_KEY,
    queryFn: () => list({}),
    refetchOnWindowFocus: false,
    staleTime: 0,
    retry: false,
  });
  const [selected, setSelected] = useState<PolicyEditorState | null>(null);
  const saved = (result: SavedPolicy) => {
    queryClient.setQueryData<PolicySnapshot>(POLICIES_KEY, (snapshot) => ({
      revision: result.revision,
      policies: [
        ...(snapshot?.policies ?? []).filter((policy) => policy.id !== result.policy.id),
        result.policy,
      ],
    }));
    onChanged();
  };
  const deleted = (result: DeletedPolicy) => {
    queryClient.setQueryData<PolicySnapshot>(POLICIES_KEY, (snapshot) => ({
      revision: result.revision,
      policies: (snapshot?.policies ?? []).filter((policy) => policy.id !== result.id),
    }));
    setSelected(null);
    onChanged();
  };
  return (
    <Modal title="Runtime policies" open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        {selected ? (
          <PolicyForm
            colors={colors}
            initial={selected}
            onSaved={saved}
            onDeleted={deleted}
            onReload={() => {
              setSelected(null);
              void query.refetch();
            }}
          />
        ) : (
          <PolicyPicker
            colors={colors}
            snapshot={query.data}
            loading={query.isFetching}
            error={query.error ? errorText(query.error) : null}
            onRetry={() => void query.refetch()}
            onSelect={setSelected}
          />
        )}
      </Modal.Content>
    </Modal>
  );
}

function PolicyPicker({
  colors,
  snapshot,
  loading,
  error,
  onRetry,
  onSelect,
}: {
  colors: Colors;
  snapshot: PolicySnapshot | undefined;
  loading: boolean;
  error: string | null;
  onRetry(): void;
  onSelect(state: PolicyEditorState): void;
}) {
  return (
    <View style={{ gap: 16 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: ui(13) }}>
        Saving creates an immutable revision. Bindings following the latest revision use the new revision for
        future chats; pinned revisions and active chats stay unchanged. Policies do not grant permissions.
      </Text>
      {error ? <PolicyMessage colors={colors} text={error} /> : null}
      <Button colors={colors} label="Reload saved policies" loading={loading} onPress={onRetry} />
      {snapshot ? (
        <SettingsCard>
          <SettingsSelect
            label="Existing policy"
            value=""
            disabled={loading || !!error}
            options={[
              { label: "Choose a policy", value: "" },
              ...snapshot.policies.map((policy) => ({
                label: `${policy.name} (revision ${policy.revision}, ${policy.id})`,
                value: policy.id,
              })),
            ]}
            onValueChange={(id) => {
              const policy = snapshot.policies.find((item) => item.id === id);
              if (policy) onSelect(createPolicyEditor(snapshot.revision, policy));
            }}
          />
        </SettingsCard>
      ) : null}
      <Button
        colors={colors}
        label="New policy"
        disabled={!snapshot || loading || !!error}
        onPress={() => snapshot && onSelect(createPolicyEditor(snapshot.revision, null))}
      />
    </View>
  );
}

interface PolicyFormProps {
  colors: Colors;
  initial: PolicyEditorState;
  onSaved(result: SavedPolicy): void;
  onDeleted(result: DeletedPolicy): void;
  onReload(): void;
}

function PolicyForm({ colors, initial, onSaved, onDeleted, onReload }: PolicyFormProps) {
  const [state, dispatch] = useReducer(policyEditorReducer, initial);
  const actions = usePolicyMutations({ state, dispatch, onSaved, onDeleted });
  const parsed = parsePolicyDraft(state.draft);
  return (
    <View style={{ gap: 16 }}>
      <PolicyHistory colors={colors} policy={state.policy} />
      <PolicyFields colors={colors} state={state} dispatch={dispatch} disabled={actions.pending} />
      {!parsed.ok ? <PolicyMessage colors={colors} text={parsed.error} /> : null}
      <PolicyFeedback colors={colors} state={state} />
      <View style={{ gap: 12 }}>
        <Button
          colors={colors}
          label={state.policy ? "Save new revision" : "Create policy"}
          variant="default"
          loading={actions.pending}
          disabled={!parsed.ok || state.conflict}
          onPress={actions.save}
        />
        <PolicyDelete colors={colors} state={state} dispatch={dispatch} actions={actions} />
        <Button
          colors={colors}
          label="Reload saved policies (discard draft)"
          disabled={actions.pending}
          onPress={onReload}
        />
      </View>
    </View>
  );
}

function PolicyFields({
  colors,
  state,
  dispatch,
  disabled,
}: {
  colors: Colors;
  state: PolicyEditorState;
  dispatch: Dispatch<PolicyEditorAction>;
  disabled: boolean;
}) {
  const edit = (patch: Partial<PolicyEditorState["draft"]>) => dispatch({ type: "edit", patch });
  return (
    <SettingsSection title="Policy body">
      <SettingsCard>
        <InputField
          key={`${state.policy?.id}-${state.policy?.revision}`}
          colors={colors}
          label="Name"
          initialValue={state.draft.name}
          disabled={disabled}
          onChangeText={(name) => edit({ name })}
        />
        <TextAreaField
          colors={colors}
          label="Purpose"
          value={state.draft.purpose}
          editable={!disabled}
          onChangeText={(purpose) => edit({ purpose })}
        />
        <TextAreaField
          colors={colors}
          label="Advanced settings (JSON)"
          hint="taskClasses, roles, routing, budget, concurrency. Omitted fields inherit. Remove a key to reset it to inherited."
          monospace
          autoCapitalize="none"
          autoCorrect={false}
          minHeight={280}
          value={state.draft.advanced}
          editable={!disabled}
          onChangeText={(advanced) => edit({ advanced })}
        />
      </SettingsCard>
      <Text style={{ color: colors.foregroundMuted, fontSize: ui(12) }}>
        Model and thinkingOptionId: null means provider default, not inherit. Delegated
        planner/advisor/verifier/reviewer: null disables delegation. Budget and concurrency limits: null means
        unlimited. Provider and executor cannot be null. Use provider/model IDs as supplied by your host;
        there is no model allowlist. Approval and tool permissions remain separate from this policy.
      </Text>
    </SettingsSection>
  );
}

function PolicyHistory({ colors, policy }: { colors: Colors; policy: Policy | null }) {
  const get = useRpc(policiesGetRpc);
  const history = useQuery({
    queryKey: [...POLICIES_KEY, policy?.id, policy?.revision],
    queryFn: () => get({ id: policy?.id ?? "", revision: policy?.revision }),
    enabled: !!policy,
    retry: false,
  });
  if (!policy) return <Text style={{ color: colors.foreground }}>New policy, revision 1</Text>;
  return (
    <View style={{ gap: 6 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: ui(13) }}>
        {policy.name} / {policy.id} / editing revision {policy.revision}
      </Text>
      {history.data ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: ui(12) }}>
          Saved revisions: {history.data.revisions.join(", ")}. Saving appends a revision, never replaces one.
        </Text>
      ) : null}
      {history.error ? (
        <PolicyMessage colors={colors} text={`History unavailable: ${errorText(history.error)}`} />
      ) : null}
    </View>
  );
}

function PolicyMessage({ colors, text }: { colors: Colors; text: string }) {
  return (
    <Text accessibilityRole="alert" selectable style={{ color: colors.foreground, fontSize: ui(13) }}>
      {text}
    </Text>
  );
}

function PolicyFeedback({ colors, state }: { colors: Colors; state: PolicyEditorState }) {
  return (
    <View style={{ gap: 6 }}>
      {state.notice ? <PolicyMessage colors={colors} text={state.notice} /> : null}
      {state.referrers.map((referrer) => {
        const label = policyReferrerLabel(referrer);
        return (
          <Text key={label} selectable style={{ color: colors.foreground, fontSize: ui(13) }}>
            {label}
          </Text>
        );
      })}
    </View>
  );
}

interface MutationOptions {
  state: PolicyEditorState;
  dispatch: Dispatch<PolicyEditorAction>;
  onSaved(result: SavedPolicy): void;
  onDeleted(result: DeletedPolicy): void;
}

interface PolicyMutationActions {
  save(): void;
  remove(): void;
  pending: boolean;
}

function usePolicyMutations(options: MutationOptions): PolicyMutationActions {
  const saveRpc = useRpc(policiesSaveRpc);
  const deleteRpc = useRpc(policiesDeleteRpc);
  const { state, dispatch } = options;
  const onError = (error: unknown) => dispatch({ type: "error", message: errorText(error) });
  const save = useMutation({
    retry: false,
    mutationFn: async () => {
      const parsed = parsePolicyDraft(state.draft);
      if (!parsed.ok || state.conflict) return;
      const result = await saveRpc({ revision: state.revision, id: state.policy?.id, policy: parsed.policy });
      if (result.status === "conflict") dispatch({ type: "refused", result });
      else {
        dispatch({ type: "saved", ...result });
        options.onSaved(result);
      }
    },
    onError,
  });
  const remove = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!state.policy || state.conflict || !state.confirmDelete) return;
      const result = await deleteRpc({ revision: state.revision, id: state.policy.id });
      if (result.status === "deleted") options.onDeleted({ revision: result.revision, id: state.policy.id });
      else dispatch({ type: "refused", result });
    },
    onError,
  });
  return {
    save: () => save.mutate(),
    remove: () => remove.mutate(),
    pending: save.isPending || remove.isPending,
  };
}

function PolicyDelete({
  colors,
  state,
  dispatch,
  actions,
}: {
  colors: Colors;
  state: PolicyEditorState;
  dispatch: Dispatch<PolicyEditorAction>;
  actions: PolicyMutationActions;
}) {
  if (!state.policy) return null;
  return (
    <View style={{ gap: 8 }}>
      {state.confirmDelete ? (
        <>
          <PolicyMessage
            colors={colors}
            text="Delete this policy and every revision? Referenced policies cannot be deleted."
          />
          <Button
            colors={colors}
            label="Confirm delete all revisions"
            disabled={state.conflict || actions.pending}
            onPress={actions.remove}
          />
          <Button
            colors={colors}
            label="Keep policy"
            disabled={actions.pending}
            onPress={() => dispatch({ type: "confirm-delete", value: false })}
          />
        </>
      ) : (
        <Button
          colors={colors}
          label="Delete policy"
          disabled={state.conflict || actions.pending}
          onPress={() => dispatch({ type: "confirm-delete", value: true })}
        />
      )}
    </View>
  );
}
