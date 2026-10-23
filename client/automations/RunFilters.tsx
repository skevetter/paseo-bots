import { SettingsCard, SettingsSelect } from "@getpaseo/plugin/client/ui";
import type { Bot } from "../../shared/bot";
import { EXECUTION_STATUSES } from "../../shared/runs";
import type { RunFiltersValue } from "./run-state";

export function RunFilters({
  bots,
  value,
  onChange,
}: {
  bots: readonly Bot[];
  value: RunFiltersValue;
  onChange(value: RunFiltersValue): void;
}) {
  const bot = bots.find((entry) => entry.id === value.botId);
  const botOptions = bots.map((entry) => ({ value: entry.id, label: `${entry.name} (${entry.id})` }));
  if (value.botId && !bot) botOptions.push({ value: value.botId, label: value.botId });
  const routines =
    bot?.routines.map((entry) => ({ value: entry.id, label: `${entry.name} (${entry.id})` })) ?? [];
  if (value.routineId && !routines.some((entry) => entry.value === value.routineId))
    routines.push({ value: value.routineId, label: value.routineId });
  return (
    <SettingsCard>
      <SettingsSelect
        label="Filter bot"
        value={value.botId}
        options={[{ value: "", label: "All bots" }, ...botOptions]}
        onValueChange={(botId) => onChange({ ...value, botId })}
      />
      <SettingsSelect
        label="Filter routine"
        hint={bot ? "Schedules for the selected bot." : "Select a bot to choose one of its routines."}
        value={value.routineId}
        options={[{ value: "", label: "All routines" }, ...routines]}
        onValueChange={(routineId) => onChange({ ...value, routineId })}
      />
      <SettingsSelect
        label="Filter execution status"
        value={value.executionStatus}
        options={[
          { value: "", label: "All execution statuses" },
          ...EXECUTION_STATUSES.map((status) => ({ value: status, label: status })),
        ]}
        onValueChange={(executionStatus) => {
          if (executionStatus === "" || EXECUTION_STATUSES.some((status) => status === executionStatus))
            onChange({ ...value, executionStatus: executionStatus as RunFiltersValue["executionStatus"] });
        }}
      />
    </SettingsCard>
  );
}
