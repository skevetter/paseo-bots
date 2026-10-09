import { View } from "react-native";
import type { Routine } from "../../../shared/bot";
import { describeSchedule, nextRun } from "../../../shared/routines";
import type { RoutineRecord, RoutineRun } from "../../../shared/rpc";
import { relativeTime } from "../../../shared/time";
import { actionsLabel } from "../../a11y";
import { type MenuEntry, useMenu } from "../../ui/Menu";
import type { PanelProps } from "../BotPanel";
import { KebabButton, PressableRow, RowText } from "../rows";
import { StatusBadge } from "../status";
import { routineState, runStartError } from "./runs";
import type { RoutineActions } from "./useRoutineActions";

type Colors = PanelProps["colors"];

/** Matches Paseo's formatNextRun (utils/schedule-format.ts). */
function formatNextRun(next: Date, now: number = Date.now()): string {
  const diff = next.getTime() - now;
  if (diff < 60_000) return "soon";
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

/** Status is left to the badge. */
function routineMeta(routine: Routine, run: RoutineRun | undefined, next: Date | null): string {
  const parts = [describeSchedule(routine.schedule)];
  const when = relativeTime(run?.startedAt);
  if (!run) parts.push("Never run");
  else if (run.status === "failed") parts.push(`Failed ${when}: ${run.error ?? "unknown error"}`);
  else if (run.status === "skipped-busy") parts.push(`Skipped ${when}, still working`);
  else if (run.status === "skipped-missed") parts.push(`Missed ${when}`);
  else parts.push(`Last run ${when}`);
  if (routine.enabled && next) parts.push(`Next run ${formatNextRun(next)}`);
  return parts.join(" · ");
}

function routineMenuEntries(routine: Routine, actions: RoutineActions, onEdit: () => void): MenuEntry[] {
  return [
    { label: "Edit routine", icon: "Pencil", onSelect: onEdit },
    routine.enabled
      ? {
          label: "Pause routine",
          icon: "Pause",
          onSelect: () => actions.update(routine.id, { enabled: false }),
        }
      : {
          label: "Resume routine",
          icon: "Play",
          onSelect: () => actions.update(routine.id, { enabled: true }),
        },
    {
      label: "Run now",
      icon: "RotateCw",
      disabled: !routine.prompt.trim() || actions.starts[routine.id]?.status === "starting",
      pendingLabel: "Starting...",
      onSelect: () => actions.run(routine),
    },
    ...(routine.schedule.kind === "webhook"
      ? [
          {
            label: "Copy webhook URL",
            icon: "Webhook",
            onSelect: () => actions.copyWebhook(routine),
          },
        ]
      : []),
    { kind: "separator" },
    {
      label: "Delete routine",
      icon: "Trash2",
      destructive: true,
      onSelect: () => void actions.remove(routine),
    },
  ];
}

export function RoutineRow({
  colors,
  routine,
  record,
  now,
  actions,
  onEdit,
}: {
  colors: Colors;
  routine: Routine;
  record: RoutineRecord | undefined;
  now: Date;
  actions: RoutineActions;
  onEdit(): void;
}) {
  const menu = useMenu();
  const next = nextRun(routine.schedule, new Date(record?.lastRunAt ?? routine.createdAt), now);
  const start = actions.starts[routine.id];
  const badge = routineState(routine, next, start);
  return (
    <PressableRow colors={colors} accessibilityLabel={`Edit routine ${routine.name}`} onPress={onEdit}>
      {() => (
        <>
          <RowText
            colors={colors}
            label={routine.name || "Untitled routine"}
            hint={routineMeta(routine, record?.runs.at(-1), next)}
            error={runStartError(start)}
            hintLines={2}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <StatusBadge colors={colors} label={badge.label} variant={badge.variant} />
            <KebabButton
              colors={colors}
              label={actionsLabel(routine.name || "Untitled routine")}
              onOpen={(anchor) =>
                menu.open({
                  anchor,
                  align: "end",
                  width: 220,
                  title: routine.name || "Routine",
                  entries: routineMenuEntries(routine, actions, onEdit),
                })
              }
            />
          </View>
        </>
      )}
    </PressableRow>
  );
}
