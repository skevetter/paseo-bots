import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo, useCallback, useState } from "react";
import { Text, View } from "react-native";
import type { TaskActivity, TaskEntry } from "../../../shared/tools";
import { nativeTokens } from "../../native";
import { ui } from "../../typography";
import { ExpandableBadge } from "./ExpandableBadge";

type Colors = PluginTheme["colors"];

const ACTIVITY_ICONS: Record<TaskActivity["type"], string> = {
  created: "SquareCheck",
  added: "Plus",
  started: "CircleDot",
  completed: "Check",
};
const ACTIVITY_LABELS: Record<Exclude<TaskActivity["type"], "created">, string> = {
  added: "Added",
  started: "Started",
  completed: "Completed",
};

export const TodoListCard = memo(function TodoListCard({
  colors,
  items,
  activity,
}: {
  colors: Colors;
  items: TaskEntry[];
  activity: TaskActivity;
}) {
  const [expanded, setExpanded] = useState(false);
  const label =
    activity.type === "created" ? `Created ${activity.count} tasks` : ACTIVITY_LABELS[activity.type];
  const secondary = activity.type === "created" ? undefined : activity.task;
  const renderDetails = useCallback(
    () => (
      <View style={{ padding: 8 }}>
        <View style={{ gap: 4 }}>
          {items.length === 0 ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: ui(14) }}>No tasks yet.</Text>
          ) : (
            items.map((task, index) => (
              <TaskListRow key={task.id ?? `${index}:${task.text}`} colors={colors} task={task} />
            ))
          )}
        </View>
      </View>
    ),
    [colors, items],
  );
  return (
    <ExpandableBadge
      colors={colors}
      label={label}
      secondaryLabel={secondary}
      icon={ACTIVITY_ICONS[activity.type]}
      isExpanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      renderDetails={renderDetails}
    />
  );
});

const TASK_ICONS = { completed: "CircleCheck", running: "CircleDot", pending: "Circle" } as const;

function taskState(task: TaskEntry): keyof typeof TASK_ICONS {
  if (task.completed || task.status === "completed") return "completed";
  return task.status === "in_progress" ? "running" : "pending";
}

function TaskListRow({ colors, task }: { colors: Colors; task: TaskEntry }) {
  const tokens = nativeTokens(colors);
  const state = taskState(task);
  const completed = state === "completed";
  const running = state === "running";
  const text = running && task.activeForm ? task.activeForm : task.text;
  const textColors = {
    completed: tokens.foregroundExtraMuted,
    running: colors.foreground,
    pending: colors.foregroundMuted,
  };
  return (
    <View accessibilityLabel={text} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon
        name={TASK_ICONS[state]}
        size={16}
        color={running ? tokens.statusDotRunning : tokens.foregroundExtraMuted}
      />
      <Text
        numberOfLines={1}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          fontSize: ui(14),
          color: textColors[state],
          ...(completed ? { textDecorationLine: "line-through" as const } : {}),
        }}
      >
        {text}
      </Text>
    </View>
  );
}
