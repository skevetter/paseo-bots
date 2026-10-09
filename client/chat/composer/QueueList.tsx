import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { ui } from "../../typography";
import { tooltip } from "../../ui/Tooltip";
import type { QueuedMessage } from "./logic";

type Colors = PluginTheme["colors"];

export function QueueList({
  colors,
  queue,
  onEdit,
  onSendNow,
}: {
  colors: Colors;
  queue: QueuedMessage[];
  onEdit(item: QueuedMessage): void;
  onSendNow(item: QueuedMessage): void;
}) {
  if (queue.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      {queue.map((item) => (
        <QueuedRow
          key={item.id}
          colors={colors}
          item={item}
          onEdit={() => onEdit(item)}
          onSendNow={() => onSendNow(item)}
        />
      ))}
    </View>
  );
}

function QueuedRow({
  colors,
  item,
  onEdit,
  onSendNow,
}: {
  colors: Colors;
  item: QueuedMessage;
  onEdit(): void;
  onSendNow(): void;
}) {
  const label = item.text || item.attachments.map((attachment) => attachment.name).join(", ");
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: colors.surface1,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Text
        numberOfLines={2}
        ellipsizeMode="tail"
        style={{ flex: 1, color: colors.foreground, fontSize: ui(14) }}
      >
        {label}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit queued message"
          {...tooltip("Edit")}
          onPress={onEdit}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.surface2,
          }}
        >
          <Icon name="Pencil" size={14} color={colors.foreground} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send queued message now"
          {...tooltip("Send now")}
          onPress={onSendNow}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.accent,
          }}
        >
          <Icon name="ArrowUp" size={14} color={colors.accentForeground} />
        </Pressable>
      </View>
    </View>
  );
}
