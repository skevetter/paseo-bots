import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useReducer, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import {
  AUTOMATION_ATTENTION,
  type AutomationAttention,
  type AutomationRow,
  type AutomationsFilter,
  automationsListRpc,
  automationsRunNowRpc,
  MAX_AUTOMATION_TARGETS,
} from "../../shared/automations";
import type { Bot } from "../../shared/bot";
import { newUuid } from "../../shared/uuid";
import { errorText } from "../native";
import { Button } from "../panel/controls";
import { InputField } from "../panel/fields";
import { CatalogChanges, useCatalogChanges } from "./CatalogChanges";
import { CatalogRow } from "./CatalogRow";
import {
  AUTOMATIONS_KEY,
  type CatalogPageEvent,
  type CatalogPages,
  type CatalogRunState,
  catalogListInput,
  catalogPages,
  catalogRunRequest,
  INITIAL_CATALOG_PAGES,
  selectCatalogIds,
} from "./catalog-state";
import { readinessMessage } from "./run-presentation";

type Colors = PluginTheme["colors"];
export function RoutineCatalog({
  colors,
  compact,
  bots,
  onRun,
  active = true,
}: {
  colors: Colors;
  compact: boolean;
  bots: readonly Bot[];
  onRun(runId: string): void;
  active?: boolean;
}) {
  const {
    query,
    pages,
    selected,
    error,
    workflow,
    runs,
    disabled,
    preview,
    addIds,
    reload,
    refresh,
    toggle,
    dispatch,
    changed,
    clearSelection,
  } = useCatalogModel(active);
  return (
    <View style={{ flex: 1, gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <Text
          accessibilityRole="header"
          style={{ color: colors.foreground, fontSize: compact ? 18 : 20, flexGrow: 1 }}
        >
          Routine catalog
        </Text>
        <Button
          colors={colors}
          label="Refresh catalog"
          loading={query.isFetching}
          onPress={() => void refresh()}
        />
      </View>
      <CatalogLoadState colors={colors} loading={query.isPending} error={query.error} onReload={reload} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 12, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <CatalogFilters
          colors={colors}
          bots={bots}
          onApply={(filters) => dispatch({ type: "filter", filters })}
        />
        <Text style={{ color: colors.foregroundMuted }}>
          Global server filters; at most 100 routines per page. Attention filters include only observed server
          evidence, not unavailable signals.
        </Text>
        <CatalogReadiness
          colors={colors}
          readiness={query.data?.readiness}
          observedAt={query.data?.observedAt}
        />
        <Text style={{ color: colors.foregroundMuted }}>
          {query.data?.rows.length ?? 0} shown; {selected.length} selected across pages and filters (maximum{" "}
          {MAX_AUTOMATION_TARGETS}). Selection contains exact target IDs, not all matching routines.
        </Text>
        <CatalogSelectionActions
          colors={colors}
          count={selected.length}
          rows={query.data?.rows}
          disabled={disabled}
          onAdd={addIds}
          onClear={clearSelection}
          onPreview={(enabled) => preview(selected, enabled)}
        />
        {error ? (
          <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
            {error}
          </Text>
        ) : null}
        <CatalogChanges
          colors={colors}
          workflow={workflow}
          revision={query.data?.revision ?? null}
          onChanged={changed}
        />
        <CatalogRows
          colors={colors}
          rows={query.data?.rows}
          selected={selected}
          disabled={disabled}
          runs={runs.states}
          onToggle={toggle}
          onPreview={(row) => preview([row.id], !row.enabled)}
          onRunNow={runs.start}
          onRun={onRun}
        />
        <CatalogPagination
          colors={colors}
          pages={pages}
          cursor={query.data?.cursor ?? null}
          fetching={query.isFetching}
          failed={!!query.error}
          dispatch={dispatch}
          onReload={reload}
        />
      </ScrollView>
    </View>
  );
}

function CatalogSelectionActions({
  colors,
  count,
  rows,
  disabled,
  onAdd,
  onClear,
  onPreview,
}: {
  colors: Colors;
  count: number;
  rows: AutomationRow[] | undefined;
  disabled: boolean;
  onAdd(ids: readonly string[]): void;
  onClear(): void;
  onPreview(enabled: boolean): void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Button
        colors={colors}
        label="Select current page"
        disabled={!rows?.length}
        onPress={() => onAdd(rows?.map((row) => row.id) ?? [])}
      />
      <Button colors={colors} label="Clear selection" disabled={count === 0} onPress={onClear} />
      <Button
        colors={colors}
        label={`Preview pause ${count} selected`}
        disabled={disabled || count === 0}
        onPress={() => onPreview(false)}
      />
      <Button
        colors={colors}
        label={`Preview resume ${count} selected`}
        disabled={disabled || count === 0}
        onPress={() => onPreview(true)}
      />
    </View>
  );
}

function useCatalogModel(active: boolean) {
  const list = useRpc(automationsListRpc);
  const queryClient = useQueryClient();
  const [pages, dispatch] = useReducer(catalogPages, INITIAL_CATALOG_PAGES);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const input = catalogListInput(pages);
  const query = useQuery({
    queryKey: [...AUTOMATIONS_KEY, "list", input],
    queryFn: () => list(input),
    enabled: active,
    refetchInterval: active ? 5_000 : false,
    retry: false,
  });
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_KEY });
    void queryClient.invalidateQueries({ queryKey: ["paseo-bots", "runs"] });
  };
  const workflow = useCatalogChanges(changed);
  const runs = useCatalogRuns(changed);
  const actionLocked =
    workflow.state.phase === "applying" ||
    workflow.state.phase === "uncertain" ||
    workflow.revertLocked ||
    workflow.state.needsRefresh;
  const disabled = !query.data || !!query.error || query.isFetching || actionLocked;
  const preview = (ids: readonly string[], enabled: boolean) => {
    if (!query.data || disabled) return;
    void workflow.preview({
      operationId: newUuid(),
      revision: query.data.revision,
      targetIds: [...ids],
      enabled,
    });
  };
  const addIds = (ids: readonly string[]) => {
    try {
      setSelected(selectCatalogIds(selected, ids));
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const reload = () => {
    dispatch({ type: "reload" });
    changed();
  };
  const refresh = async () => {
    const result = await query.refetch();
    if (result.isSuccess) workflow.refreshed();
  };
  const toggle = (id: string) => {
    if (selected.includes(id)) setSelected(selected.filter((entry) => entry !== id));
    else addIds([id]);
  };
  const clearSelection = () => {
    setSelected([]);
    setError(null);
  };
  return {
    query,
    pages,
    selected,
    error,
    workflow,
    runs,
    disabled,
    preview,
    addIds,
    reload,
    refresh,
    toggle,
    dispatch,
    changed,
    clearSelection,
  };
}
function CatalogLoadState({
  colors,
  loading,
  error,
  onReload,
}: {
  colors: Colors;
  loading: boolean;
  error: Error | null;
  onReload(): void;
}) {
  return (
    <View style={{ gap: 8 }}>
      {loading ? (
        <ActivityIndicator color={colors.foregroundMuted} accessibilityLabel="Loading routine catalog" />
      ) : null}
      {error ? (
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
            Catalog refresh failed: {errorText(error)}. Displayed data may be stale. Reload the first page if
            its cursor expired.
          </Text>
          <Button colors={colors} label="Reload first catalog page" onPress={onReload} />
        </View>
      ) : null}
    </View>
  );
}
function CatalogReadiness({
  colors,
  readiness,
  observedAt,
}: {
  colors: Colors;
  readiness: "waiting_for_host_api" | "reconciling" | "ready" | "stopped" | undefined;
  observedAt: string | undefined;
}) {
  if (!readiness) return null;
  return (
    <Text style={{ color: colors.foregroundMuted }}>
      Readiness: {readiness}. {readinessMessage(readiness)} Observed: {observedAt}
    </Text>
  );
}
function CatalogRows({
  colors,
  rows,
  selected,
  disabled,
  runs,
  onToggle,
  onPreview,
  onRunNow,
  onRun,
}: {
  colors: Colors;
  rows: AutomationRow[] | undefined;
  selected: string[];
  disabled: boolean;
  runs: Record<string, CatalogRunState>;
  onToggle(id: string): void;
  onPreview(row: AutomationRow): void;
  onRunNow(row: AutomationRow, newWorkload: boolean): Promise<void>;
  onRun(runId: string): void;
}) {
  if (!rows) return null;
  if (!rows.length)
    return <Text style={{ color: colors.foregroundMuted }}>No routines match these server filters.</Text>;
  return (
    <View style={{ gap: 12 }}>
      {rows.map((row) => (
        <CatalogRow
          key={row.id}
          colors={colors}
          row={row}
          selected={selected.includes(row.id)}
          disabled={disabled}
          run={runs[row.id]}
          onToggle={() => onToggle(row.id)}
          onPreview={() => onPreview(row)}
          onRunNow={(newWorkload) => void onRunNow(row, newWorkload)}
          onRun={onRun}
        />
      ))}
    </View>
  );
}
function CatalogPagination({
  colors,
  pages,
  cursor,
  fetching,
  failed,
  dispatch,
  onReload,
}: {
  colors: Colors;
  pages: CatalogPages;
  cursor: string | null;
  fetching: boolean;
  failed: boolean;
  dispatch(event: CatalogPageEvent): void;
  onReload(): void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Button
        colors={colors}
        label="Previous catalog page"
        disabled={pages.cursors.length === 1 || fetching}
        onPress={() => dispatch({ type: "previous" })}
      />
      <Text style={{ color: colors.foregroundMuted }}>Page {pages.cursors.length}</Text>
      <Button
        colors={colors}
        label="Next catalog page"
        disabled={cursor === null || fetching || failed}
        onPress={() => dispatch({ type: "next", cursor })}
      />
      <Button
        colors={colors}
        label="First catalog page"
        disabled={pages.cursors.length === 1}
        onPress={onReload}
      />
    </View>
  );
}

function CatalogFilters({
  colors,
  bots,
  onApply,
}: {
  colors: Colors;
  bots: readonly Bot[];
  onApply(filters: AutomationsFilter): void;
}) {
  const [draft, setDraft] = useState({
    botId: "",
    teamId: "",
    provider: "",
    model: "",
    enabled: "",
    attention: "",
  });
  const apply = () =>
    onApply({
      botId: draft.botId || undefined,
      teamId: draft.teamId || undefined,
      provider: draft.provider || undefined,
      model: draft.model || undefined,
      enabled: draft.enabled === "" ? undefined : draft.enabled === "enabled",
      attention: draft.attention === "" ? undefined : (draft.attention as AutomationAttention),
    });
  return (
    <SettingsCard>
      <SettingsSelect
        label="Filter bot"
        value={draft.botId}
        options={[
          { value: "", label: "All bots" },
          ...bots.map((bot) => ({ value: bot.id, label: `${bot.name} (${bot.id})` })),
        ]}
        onValueChange={(botId) => setDraft({ ...draft, botId })}
      />
      {(["teamId", "provider", "model"] as const).map((field) => (
        <InputField
          key={field}
          colors={colors}
          label={`Filter exact ${field} ID`}
          hint="Global server filter, not a dropdown derived from this page. Empty means all."
          initialValue={draft[field]}
          onChangeText={(value) => setDraft((current) => ({ ...current, [field]: value }))}
        />
      ))}
      <SettingsSelect
        label="Filter enabled"
        value={draft.enabled}
        options={[
          { value: "", label: "All routines" },
          { value: "enabled", label: "Enabled" },
          { value: "paused", label: "Paused" },
        ]}
        onValueChange={(enabled) => setDraft({ ...draft, enabled })}
      />
      <SettingsSelect
        label="Filter attention evidence"
        value={draft.attention}
        options={[
          { value: "", label: "All attention states" },
          ...AUTOMATION_ATTENTION.map((attention) => ({ value: attention, label: attention })),
        ]}
        onValueChange={(attention) => setDraft({ ...draft, attention })}
      />
      <View style={{ padding: 12 }}>
        <Button colors={colors} label="Apply global filters" onPress={apply} />
      </View>
    </SettingsCard>
  );
}
function useCatalogRuns(onChanged: () => void) {
  const runNow = useRpc(automationsRunNowRpc);
  const queryClient = useQueryClient();
  const key = [...AUTOMATIONS_KEY, "manual-workload-session"];
  const { data: states } = useQuery<Record<string, CatalogRunState>>({
    queryKey: key,
    queryFn: () => ({}),
    initialData: {},
    enabled: false,
    gcTime: Infinity,
  });
  const update = (id: string, state: CatalogRunState) => {
    queryClient.setQueryData<Record<string, CatalogRunState>>(key, (current) => ({
      ...current,
      [id]: state,
    }));
  };
  const start = async (row: AutomationRow, newWorkload: boolean) => {
    const previous = queryClient.getQueryData<Record<string, CatalogRunState>>(key)?.[row.id];
    if (previous?.phase === "pending") return;
    const request = catalogRunRequest(
      previous,
      { botId: row.botId, routineId: row.routineId, requestId: newUuid() },
      newWorkload,
    );
    update(row.id, { request, phase: "pending", runId: null, error: null });
    try {
      const { run } = await runNow(request);
      update(row.id, { request, phase: "done", runId: run.id, error: null });
    } catch (error) {
      update(row.id, {
        request,
        phase: "uncertain",
        runId: null,
        error: `${errorText(error)} Workload outcome unknown. Retry the same request; no new identity will be created.`,
      });
    } finally {
      onChanged();
    }
  };
  return { states, start };
}
