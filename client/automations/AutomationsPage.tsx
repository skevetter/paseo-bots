import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Dispatch, useReducer, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { Bot } from "../../shared/bot";
import { type RoutineRun, runsListRpc, runsReconcileRpc } from "../../shared/rpc";
import { errorText } from "../native";
import { Button } from "../panel/controls";
import { RoutineCatalog } from "./RoutineCatalog";
import { RUNS_KEY, RunDetail } from "./RunDetail";
import { RunFilters } from "./RunFilters";
import { elapsedFact, readinessMessage } from "./run-presentation";
import { INITIAL_RUN_PAGES, type RunPageEvent, runListInput, runPages } from "./run-state";

type Colors = PluginTheme["colors"];

export function AutomationsPage({
  colors,
  compact,
  bots,
  runId,
  onRun,
  onClose,
}: {
  colors: Colors;
  compact: boolean;
  bots: readonly Bot[];
  runId: string | null;
  onRun(runId: string | null): void;
  onClose(): void;
}) {
  const [tab, setTab] = useState<"catalog" | "runs">("catalog");
  const activeTab = runId ? null : tab;
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View style={{ flex: 1, padding: compact ? 12 : 24, gap: 12, display: runId ? "none" : "flex" }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 22, flexGrow: 1 }}>
            Automations
          </Text>
          <Button
            colors={colors}
            label="Routine catalog"
            variant={tab === "catalog" ? "default" : "secondary"}
            onPress={() => setTab("catalog")}
          />
          <Button
            colors={colors}
            label="Run history"
            variant={tab === "runs" ? "default" : "secondary"}
            onPress={() => setTab("runs")}
          />
          <Button colors={colors} label="Back to bots" onPress={onClose} />
        </View>
        <View style={{ flex: 1, display: tab === "catalog" ? "flex" : "none" }}>
          <RoutineCatalog
            colors={colors}
            compact={compact}
            bots={bots}
            onRun={onRun}
            active={activeTab === "catalog"}
          />
        </View>
        <View style={{ flex: 1, display: tab === "runs" ? "flex" : "none" }}>
          <RunHistory colors={colors} bots={bots} onRun={onRun} active={activeTab === "runs"} />
        </View>
      </View>
      {runId ? (
        <RunDetail
          key={runId}
          colors={colors}
          runId={runId}
          onBack={() => onRun(null)}
          backLabel={tab === "catalog" ? "Back to routines" : "Back to run history"}
        />
      ) : null}
    </View>
  );
}

function RunHistory({
  colors,
  bots,
  onRun,
  active,
}: {
  colors: Colors;
  bots: readonly Bot[];
  onRun(runId: string): void;
  active: boolean;
}) {
  const list = useRpc(runsListRpc);
  const reconcile = useRpc(runsReconcileRpc);
  const queryClient = useQueryClient();
  const [pages, dispatch] = useReducer(runPages, INITIAL_RUN_PAGES);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = runListInput(pages);
  const query = useQuery({
    queryKey: [...RUNS_KEY, "list", input],
    queryFn: () => list(input),
    enabled: active,
    refetchInterval: active ? 5_000 : false,
    retry: false,
  });
  const reload = () => {
    dispatch({ type: "reload" });
    void queryClient.invalidateQueries({ queryKey: [...RUNS_KEY, "list"] });
  };
  const reconcileAll = async () => {
    if (reconciling) return;
    setReconciling(true);
    setError(null);
    try {
      await reconcile({});
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
      setReconciling(false);
    }
  };
  return (
    <View style={{ flex: 1, gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 22, flexGrow: 1 }}>
          Run history
        </Text>
        <Button
          colors={colors}
          label="Refresh page"
          loading={query.isFetching}
          disabled={reconciling}
          onPress={() => void query.refetch()}
        />
        <Button
          colors={colors}
          label="Reconcile runs"
          loading={reconciling}
          onPress={() => void reconcileAll()}
        />
      </View>
      {query.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading runs" color={colors.foregroundMuted} />
      ) : null}
      {query.error ? (
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
            Run refresh failed: {errorText(query.error)}. Displayed data may be stale. If a cursor was
            removed, reload the first page.
          </Text>
          <Button colors={colors} label="Reload first page" onPress={reload} />
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
          {error}
        </Text>
      ) : null}
      {query.data ? (
        <Text style={{ color: colors.foregroundMuted }}>
          Readiness: {query.data.readiness}. {readinessMessage(query.data.readiness)}
        </Text>
      ) : null}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 12, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <RunFilters
          bots={bots}
          value={pages.filters}
          onChange={(filters) => dispatch({ type: "filter", filters })}
        />
        <Text style={{ color: colors.foregroundMuted }}>
          Server-filtered history, 25 runs per page. Execution and task outcome are independent facts. No
          client-only filters are applied to a partial page.
        </Text>
        {query.isSuccess && query.data.runs.length === 0 ? (
          <Text style={{ color: colors.foregroundMuted }}>No retained runs match these filters.</Text>
        ) : null}
        {query.data?.runs.map((run) => (
          <RunRow key={run.id} colors={colors} run={run} bots={bots} onDetails={() => onRun(run.id)} />
        ))}
        <RunPagination
          colors={colors}
          page={pages.cursors.length}
          cursor={query.data?.cursor ?? null}
          busy={query.isFetching}
          failed={!!query.error}
          dispatch={dispatch}
          onReload={reload}
        />
      </ScrollView>
    </View>
  );
}

function RunPagination({
  colors,
  page,
  cursor,
  busy,
  failed,
  dispatch,
  onReload,
}: {
  colors: Colors;
  page: number;
  cursor: string | null;
  busy: boolean;
  failed: boolean;
  dispatch: Dispatch<RunPageEvent>;
  onReload(): void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Button
        colors={colors}
        label="Previous page"
        disabled={page === 1 || busy}
        onPress={() => dispatch({ type: "previous" })}
      />
      <Text style={{ color: colors.foregroundMuted }}>Page {page}</Text>
      <Button
        colors={colors}
        label="Next page"
        disabled={cursor === null || busy || failed}
        onPress={() => dispatch({ type: "next", cursor })}
      />
      <Button colors={colors} label="First page" disabled={page === 1} onPress={onReload} />
    </View>
  );
}

function RunRow({
  colors,
  run,
  bots,
  onDetails,
}: {
  colors: Colors;
  run: RoutineRun;
  bots: readonly Bot[];
  onDetails(): void;
}) {
  const bot = bots.find((entry) => entry.id === run.managed?.botId);
  const routine = bot?.routines.find((entry) => entry.id === run.managed?.routineId);
  return (
    <View style={{ padding: 12, gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
      <Text style={{ color: colors.foreground }}>
        {bot?.name ?? run.managed?.botId ?? "Historic run (bot metadata unavailable)"} /{" "}
        {routine?.name ?? run.managed?.routineId ?? "No routine metadata"}
      </Text>
      <Text style={{ color: colors.foreground }}>Execution: {run.executionStatus}</Text>
      <Text style={{ color: colors.foreground }}>Task outcome: {run.taskOutcome}</Text>
      <Text style={{ color: colors.foregroundMuted }}>
        Purpose: {run.purpose}; trigger: {run.trigger}; skipped: {run.skipped ?? "no"}
      </Text>
      <Text selectable style={{ color: colors.foregroundMuted }}>
        Run: {run.id}; attempt: {run.attemptId}
      </Text>
      <Text selectable style={{ color: colors.foregroundMuted }}>
        Occurrence: {run.occurrenceKey}
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>
        Scheduled: {run.scheduledFor}; elapsed: {elapsedFact(run, Date.now())}
      </Text>
      {run.managed?.cancelRequested ? (
        <Text style={{ color: colors.foregroundMuted }}>
          Cancellation requested, not confirmed. Effects may be unknown.
        </Text>
      ) : null}
      <Button colors={colors} label={`Details for ${run.id}`} onPress={onDetails} />
    </View>
  );
}
