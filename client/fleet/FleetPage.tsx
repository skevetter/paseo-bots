import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { type FleetRow, fleetListRpc, MAX_FLEET_TARGETS } from "../../shared/fleet";
import type { Inheritable, Policy, Source } from "../../shared/policies";
import { errorText } from "../native";
import { Button } from "../panel/controls";
import { SlideOver } from "../ui/Columns";
import { bindCheckboxKeys, type DomElement } from "../web";
import { BulkPolicySheet } from "./BulkPolicySheet";
import { PolicyEditor } from "./PolicyEditor";
import { EMPTY_FILTERS, type FleetFilters, filterFleet, selectionKey, toggleSelection } from "./selection";

type Colors = PluginTheme["colors"];
const FLEET_KEY = ["paseo-bots", "fleet"] as const;
interface SheetTarget {
  botIds: string[];
  unset: Inheritable[];
}

export function FleetPage({
  colors,
  compact,
  onClose,
}: {
  colors: Colors;
  compact: boolean;
  onClose(): void;
}) {
  const list = useRpc(fleetListRpc);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: FLEET_KEY, queryFn: () => list({}), refetchInterval: 5_000 });
  const [filters, setFilters] = useState<FleetFilters>(EMPTY_FILTERS);
  const [selection, setSelection] = useState<{ selected: string[]; anchor: string | null }>({
    selected: [],
    anchor: null,
  });
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [policiesOpen, setPoliciesOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const rows = query.data?.rows ?? [];
  const policies = query.data?.policies ?? [];
  const visible = filterFleet(rows, filters);
  const visibleIds = visible.map((row) => row.bot.id);
  const detail = rows.find((row) => row.bot.id === detailId);
  const toggle = (botId: string, range: boolean) =>
    setSelection((current) => toggleSelection({ ...current, visibleIds, botId, range }));
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: ["paseo-bots"] });
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0, padding: compact ? 12 : 24, gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 22, flexGrow: 1 }}>
          Fleet
        </Text>
        <Button colors={colors} label="Policies" onPress={() => setPoliciesOpen(true)} />
        <Button
          colors={colors}
          label="Refresh"
          loading={query.isFetching}
          onPress={() => void query.refetch()}
        />
        <Button colors={colors} label="Back to bots" onPress={onClose} />
      </View>
      <FleetLoadState colors={colors} loading={query.isPending} error={query.error} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 12, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <FleetFilterControls rows={rows} policies={policies} filters={filters} onChange={setFilters} />
        <Text style={{ color: colors.foregroundMuted }}>
          {visible.length} shown / {rows.length} total. {selection.selected.length} selected (including hidden
          rows). Tab to a checkbox; Space or Enter toggles it. Shift selects a visible range.
        </Text>
        <FleetSelectionActions
          colors={colors}
          count={selection.selected.length}
          disabled={!!query.error}
          visibleCount={visible.length}
          onSelectVisible={() =>
            setSelection((current) => ({
              ...current,
              selected: [...new Set([...current.selected, ...visibleIds])],
            }))
          }
          onClear={() => setSelection({ selected: [], anchor: null })}
          onChange={() => setSheet({ botIds: [...selection.selected], unset: [] })}
        />
        {!query.isPending && !visible.length ? (
          <Text style={{ color: colors.foregroundMuted }}>No bots match these filters.</Text>
        ) : null}
        {visible.map((row) => (
          <FleetBotRow
            key={row.bot.id}
            colors={colors}
            row={row}
            selected={selection.selected.includes(row.bot.id)}
            onToggle={(range) => toggle(row.bot.id, range)}
            onDetails={() => setDetailId(row.bot.id)}
          />
        ))}
      </ScrollView>
      {detail ? (
        <SlideOver onClose={() => setDetailId(null)}>
          <FleetDetails
            colors={colors}
            row={detail}
            onClose={() => setDetailId(null)}
            onReset={(field) => setSheet({ botIds: [detail.bot.id], unset: [field] })}
          />
        </SlideOver>
      ) : null}
      {sheet && query.data ? (
        <BulkPolicySheet
          colors={colors}
          revision={query.data.revision}
          botIds={sheet.botIds}
          initialUnset={sheet.unset}
          policies={policies}
          onClose={() => setSheet(null)}
          onChanged={changed}
          onRefresh={() => void query.refetch()}
        />
      ) : null}
      {policiesOpen ? (
        <PolicyEditor colors={colors} onClose={() => setPoliciesOpen(false)} onChanged={changed} />
      ) : null}
    </View>
  );
}

function FleetLoadState({
  colors,
  loading,
  error,
}: {
  colors: Colors;
  loading: boolean;
  error: Error | null;
}) {
  if (loading) return <ActivityIndicator color={colors.foregroundMuted} accessibilityLabel="Loading fleet" />;
  if (!error) return null;
  return (
    <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
      Fleet unavailable: {errorText(error)}. Refresh to retry.
    </Text>
  );
}

function FleetSelectionActions(props: {
  colors: Colors;
  count: number;
  disabled: boolean;
  visibleCount: number;
  onSelectVisible(): void;
  onClear(): void;
  onChange(): void;
}) {
  const { colors, count } = props;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          colors={colors}
          label="Select visible"
          disabled={props.visibleCount === 0}
          onPress={props.onSelectVisible}
        />
        <Button colors={colors} label="Clear selection" disabled={count === 0} onPress={props.onClear} />
        <Button
          colors={colors}
          label={`Change ${count} selected`}
          disabled={count === 0 || count > MAX_FLEET_TARGETS || props.disabled}
          variant="default"
          onPress={props.onChange}
        />
      </View>
      {count > MAX_FLEET_TARGETS ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
          Select at most {MAX_FLEET_TARGETS} bots per operation.
        </Text>
      ) : null}
    </View>
  );
}

function FleetFilterControls({
  rows,
  policies,
  filters,
  onChange,
}: {
  rows: FleetRow[];
  policies: Policy[];
  filters: FleetFilters;
  onChange(filters: FleetFilters): void;
}) {
  const options = {
    team: [
      ...new Map(
        rows
          .filter((row) => row.teamId)
          .map((row) => [
            row.teamId,
            { value: row.teamId as string, label: row.teamName ?? (row.teamId as string) },
          ]),
      ).values(),
    ],
    provider: valueOptions(rows.map((row) => row.resolution.provider.value)),
    model: valueOptions(rows.map((row) => row.resolution.model.value)),
    policy: policies.map((policy) => ({ value: policy.id, label: policy.name })),
    status: valueOptions(rows.map((row) => row.executionStatus)),
  };
  return (
    <SettingsCard>
      {(["team", "provider", "model", "policy", "status"] as const).map((field) => (
        <SettingsSelect
          key={field}
          label={`Filter ${field}`}
          value={filters[field]}
          options={[{ label: "All", value: "" }, ...options[field]]}
          onValueChange={(value) => onChange({ ...filters, [field]: value })}
        />
      ))}
      <SettingsSwitch
        label="Inheritance exceptions only"
        hint="Explicit execution overrides or resolution issues."
        value={filters.exceptions}
        onValueChange={(exceptions) => onChange({ ...filters, exceptions })}
      />
    </SettingsCard>
  );
}

function valueOptions(values: (string | null)[]) {
  return [...new Set(values.filter((value): value is string => value !== null))]
    .sort()
    .map((value) => ({ label: value, value }));
}

function FleetBotRow({
  colors,
  row,
  selected,
  onToggle,
  onDetails,
}: {
  colors: Colors;
  row: FleetRow;
  selected: boolean;
  onToggle(range: boolean): void;
  onDetails(): void;
}) {
  const ref = useRef<View>(null);
  const toggle = useRef(onToggle);
  toggle.current = onToggle;
  useEffect(
    () =>
      bindCheckboxKeys(ref.current as unknown as DomElement, {
        accepts: selectionKey,
        toggle: (range) => toggle.current(range),
      }),
    [],
  );
  return (
    <View
      style={{
        padding: 12,
        gap: 8,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.border,
        borderRadius: 8,
        backgroundColor: colors.surface1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Pressable
          ref={ref}
          accessibilityRole="checkbox"
          accessibilityLabel={`Select ${row.bot.name}`}
          accessibilityState={{ checked: selected }}
          onPress={(event) => {
            const native = event.nativeEvent;
            onToggle("shiftKey" in native && native.shiftKey === true);
          }}
          style={{
            minHeight: 44,
            minWidth: 44,
            justifyContent: "center",
            alignItems: "center",
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 6,
          }}
        >
          <Text style={{ color: colors.foreground }}>{selected ? "[x]" : "[ ]"}</Text>
        </Pressable>
        <Text style={{ color: colors.foreground, flex: 1, fontWeight: "600" }}>{row.bot.name}</Text>
        <Button colors={colors} label={`Details: ${row.bot.name}`} onPress={onDetails} />
      </View>
      <ResolutionText colors={colors} row={row} />
      <Text style={{ color: colors.foregroundMuted }}>
        Team: {row.teamName ?? "none"} | Execution: {row.executionStatus ?? "unavailable"} | Outcome:{" "}
        {row.lastOutcome}
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>
        Active work: {row.activeWork ?? "unavailable"} | Spend:{" "}
        {row.spendUsd === null ? "unavailable" : `$${row.spendUsd.toFixed(2)}`}
      </Text>
      {row.attention.length ? (
        <Text style={{ color: colors.statusDanger }}>Attention: {row.attention.join("; ")}</Text>
      ) : null}
    </View>
  );
}

function sourceText(source: Source): string {
  return `${source.layer}${source.policyId ? `: ${source.policyId} revision ${source.revision}` : ""}`;
}

function ResolutionText({ colors, row }: { colors: Colors; row: FleetRow }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foreground }}>
        Provider: {row.resolution.provider.value ?? "unresolved"} (
        {sourceText(row.resolution.provider.source)})
      </Text>
      <Text style={{ color: colors.foreground }}>
        Model: {row.resolution.model.value ?? "provider default"} ({sourceText(row.resolution.model.source)})
      </Text>
      <Text style={{ color: colors.foregroundMuted }}>
        Bot policy:{" "}
        {row.bot.policy?.binding
          ? `${row.bot.policy.binding.policyId} / ${row.bot.policy.binding.revision ?? "latest"}`
          : "none (team/global may apply)"}
      </Text>
    </View>
  );
}

function FleetDetails({
  colors,
  row,
  onClose,
  onReset,
}: {
  colors: Colors;
  row: FleetRow;
  onClose(): void;
  onReset(field: Inheritable): void;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0, padding: 16, gap: 12 }}>
      <Button colors={colors} label="Close details" onPress={onClose} />
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 20 }}>
          {row.bot.name}
        </Text>
        <ResolutionText colors={colors} row={row} />
        <Text style={{ color: colors.foregroundMuted }}>
          Reset uses the same exact-target preview and atomic apply. It never changes active chats.
        </Text>
        {(["provider", "model", "thinkingOptionId"] as const).map((field) => (
          <Button
            key={field}
            colors={colors}
            label={`Reset ${field} to inherited`}
            onPress={() => onReset(field)}
          />
        ))}
        <Text selectable style={{ color: colors.foreground, fontSize: 12 }}>
          {JSON.stringify(row.resolution, null, 2)}
        </Text>
      </ScrollView>
    </View>
  );
}
