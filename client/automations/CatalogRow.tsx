import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { AUTOMATION_ATTENTION, type AutomationRow } from "../../shared/automations";
import type { Resolution, Source } from "../../shared/policies";
import { Button } from "../panel/controls";
import type { CatalogRunState } from "./catalog-state";

type Colors = PluginTheme["colors"];
const SCHEDULE_SEMANTICS: Record<AutomationRow["schedule"]["kind"], string> = {
  daily: "wall-clock",
  cron: "wall-clock",
  interval: "elapsed interval (not wall-clock cron)",
  once: "absolute instant",
  webhook: "event-driven webhook",
};
export function CatalogRow({
  colors,
  row,
  selected,
  disabled,
  run,
  onToggle,
  onPreview,
  onRunNow,
  onRun,
}: {
  colors: Colors;
  row: AutomationRow;
  selected: boolean;
  disabled: boolean;
  run: CatalogRunState | undefined;
  onToggle(): void;
  onPreview(): void;
  onRunNow(newWorkload: boolean): void;
  onRun(runId: string): void;
}) {
  return (
    <View style={{ padding: 12, gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
      <SettingsSwitch
        label={`Select ${row.botName} / ${row.routineName}`}
        hint={`Target ID: ${row.id}`}
        value={selected}
        onValueChange={onToggle}
      />
      <Text selectable style={{ color: colors.foreground }}>
        {row.botName} ({row.botId}) / {row.routineName} ({row.routineId})
      </Text>
      <CatalogIdentityFacts colors={colors} row={row} />
      <ScheduleFacts colors={colors} row={row} />
      <CatalogExecutionFacts colors={colors} row={row} />
      <PolicyFacts colors={colors} resolution={row.resolution} />
      <Text style={{ color: colors.foregroundMuted }}>
        Current launch selection: {row.selectedModel ?? "unavailable"}; reason: {row.selectionReason}. This is
        current configuration, not an immutable admitted run snapshot.
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>Spend: unavailable; escalations: unavailable</Text>
      {row.executionMode === "legacy" ? (
        <Text style={{ color: colors.foregroundMuted }}>
          Legacy fixed-model execution: resolved policy is configuration evidence, not managed accounting or
          enforcement.
        </Text>
      ) : null}
      {AUTOMATION_ATTENTION.map((kind) => (
        <Text
          key={kind}
          style={{ color: row.attention[kind].value === true ? colors.statusDanger : colors.foregroundMuted }}
        >
          {kind}: {attentionValue(row.attention[kind].value)} - {row.attention[kind].reason}
        </Text>
      ))}
      {row.unavailable.map((reason) => (
        <Text key={reason} style={{ color: colors.foregroundMuted }}>
          Unavailable: {reason}
        </Text>
      ))}
      {row.selectionIssues.map((issue) => (
        <Text
          key={`${issue.code}:${issue.field}:${issue.message}`}
          accessibilityRole="alert"
          style={{ color: colors.statusDanger }}
        >
          {issue.field}: {issue.message} ({issue.code})
        </Text>
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          colors={colors}
          label={row.enabled ? "Preview pause" : "Preview resume"}
          disabled={disabled}
          onPress={onPreview}
        />
        <RunNowAction colors={colors} run={run} disabled={disabled} onRunNow={onRunNow} />
        <ObservedRunButton
          colors={colors}
          runId={row.lastRunId}
          label="Open last retained run"
          onRun={onRun}
        />
        <ObservedRunButton colors={colors} runId={run?.runId} label="Open requested run" onRun={onRun} />
      </View>
      {run?.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
          {run.error}
        </Text>
      ) : null}
      {run?.request ? (
        <Text selectable style={{ color: colors.foregroundMuted }}>
          Manual workload request: {run.request.requestId}
        </Text>
      ) : null}
    </View>
  );
}
function CatalogIdentityFacts({ colors, row }: { colors: Colors; row: AutomationRow }) {
  return (
    <Text style={{ color: colors.foregroundMuted }}>
      Team: {row.teamId ? `${row.teamName ?? "unnamed"} (${row.teamId})` : "none"};{" "}
      {row.enabled ? "enabled" : "paused"}; execution mode: {row.executionMode}
    </Text>
  );
}
function CatalogExecutionFacts({ colors, row }: { colors: Colors; row: AutomationRow }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foreground }}>
        Last execution: {row.lastExecutionStatus ?? "unavailable"}; task outcome:{" "}
        {row.lastTaskOutcome ?? "unavailable"}
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>
        Retained ledger: active {row.active.count}; permission wait {row.active.waiting}; unknown{" "}
        {row.active.unknown}; source: {row.active.source}. Not a complete live-host census.
      </Text>
      <Text selectable style={{ color: colors.foregroundMuted }}>
        Owner:{" "}
        {row.owner
          ? `${row.owner.agentId} (${row.owner.status})`
          : "unavailable - no unique observed current owning agent"}
      </Text>
    </View>
  );
}
function ObservedRunButton({
  colors,
  runId,
  label,
  onRun,
}: {
  colors: Colors;
  runId: string | null | undefined;
  label: string;
  onRun(runId: string): void;
}) {
  if (!runId) return null;
  return <Button colors={colors} label={label} onPress={() => onRun(runId)} />;
}
function RunNowAction({
  colors,
  run,
  disabled,
  onRunNow,
}: {
  colors: Colors;
  run: CatalogRunState | undefined;
  disabled: boolean;
  onRunNow(newWorkload: boolean): void;
}) {
  const label =
    run?.phase === "done" ? "New run" : run?.phase === "uncertain" ? "Retry same manual workload" : "Run now";
  return (
    <Button
      colors={colors}
      label={label}
      loading={run?.phase === "pending"}
      disabled={disabled}
      onPress={() => onRunNow(run?.phase === "done")}
    />
  );
}
function attentionValue(value: boolean | null): string {
  if (value === null) return "unavailable";
  return value ? "observed" : "not observed";
}
function ScheduleFacts({ colors, row }: { colors: Colors; row: AutomationRow }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foregroundMuted }}>{row.schedule.description}</Text>
      {!row.enabled ? (
        <Text style={{ color: colors.foregroundMuted }}>
          Paused: next occurrence is prospective if resumed, not a promised launch.
        </Text>
      ) : null}
      <Text style={{ color: colors.foregroundMuted }}>
        Next UTC: {row.schedule.nextUtc ?? "unavailable"}; local: {row.schedule.nextLocal ?? "unavailable"};{" "}
        zone: {row.schedule.timeZone}
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>
        Time semantics: {SCHEDULE_SEMANTICS[row.schedule.kind]};{" "}
        {row.schedule.legacyLocalTime
          ? "legacy host-local interpretation"
          : "explicit timezone / schedule semantics"}
      </Text>
      {row.schedule.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
          {row.schedule.error}
        </Text>
      ) : null}
    </View>
  );
}
function sourceFact(source: Source): string {
  return [source.layer, source.policyId, source.revision === undefined ? null : `revision ${source.revision}`]
    .filter(Boolean)
    .join(" / ");
}
function PolicyFacts({ colors, resolution }: { colors: Colors; resolution: Resolution }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foregroundMuted }}>
        Provider: {resolution.provider.value ?? "unresolved"} ({sourceFact(resolution.provider.source)})
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>
        Model: {resolution.model.value ?? "provider default"} ({sourceFact(resolution.model.source)})
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>
        Thinking: {resolution.thinkingOptionId.value ?? "provider default"} (
        {sourceFact(resolution.thinkingOptionId.source)})
      </Text>
      {(["maxRunSeconds", "maxRunCostUsd", "maxRunTokens"] as const).map((field) => (
        <Text key={field} style={{ color: colors.foregroundMuted }}>
          Resolved {field}: {resolution.budget[field].value ?? "no configured limit"} (
          {sourceFact(resolution.budget[field].source)})
        </Text>
      ))}
      {resolution.issues.map((issue) => (
        <Text
          key={`${issue.code}:${issue.field}:${issue.message}`}
          accessibilityRole="alert"
          style={{ color: colors.statusDanger }}
        >
          {issue.field}: {issue.message} ({issue.code})
        </Text>
      ))}
    </View>
  );
}
