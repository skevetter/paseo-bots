import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { useHover } from "../native";
import { ui } from "../typography";
import type { BotSidebarProps } from "./types";

type Colors = PluginTheme["colors"];

export function SidebarEmptyState({
  colors,
  bots,
  openTab,
  hiddenArchivedCount,
  shownCount,
  onEditTeam,
  onShowArchived,
  onNewBot,
}: BotSidebarProps & { shownCount: number }) {
  const group = openTab?.group;
  if (group && shownCount === 0) {
    return (
      <EmptyState
        colors={colors}
        title="No bots on this team"
        description="Add bots to it in the team's settings."
        action={{ icon: "Pencil", label: "Edit team", onPress: () => onEditTeam(group) }}
      />
    );
  }
  if (bots.length > 0) return null;
  if (hiddenArchivedCount > 0) {
    return (
      <EmptyState
        colors={colors}
        title="All bots are archived"
        description="Show archived bots to see them here."
        action={{ icon: "Archive", label: "Show archived", onPress: onShowArchived }}
      />
    );
  }
  return (
    <EmptyState
      colors={colors}
      title="No bots yet"
      description="Create a bot to get started"
      action={{ icon: "Plus", label: "New bot", onPress: onNewBot }}
    />
  );
}

function EmptyState({
  colors,
  title,
  description,
  action,
}: {
  colors: Colors;
  title: string;
  description: string;
  action: { icon: string; label: string; onPress(): void };
}) {
  return (
    <View
      style={{
        marginHorizontal: 8,
        marginTop: 16,
        paddingTop: 24,
        paddingBottom: 16,
        paddingHorizontal: 16,
        borderRadius: 8,
        backgroundColor: colors.surface0,
        alignItems: "center",
        gap: 12,
      }}
    >
      <Text style={{ color: colors.foreground, fontSize: ui(12), fontWeight: "500", textAlign: "center" }}>
        {title}
      </Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: ui(12), textAlign: "center" }}>
        {description}
      </Text>
      <GhostButton colors={colors} icon={action.icon} label={action.label} onPress={action.onPress} />
    </View>
  );
}

function GhostButton({
  colors,
  icon,
  label,
  onPress,
}: {
  colors: Colors;
  icon: string;
  label: string;
  onPress(): void;
}) {
  const { hovered, hoverProps } = useHover();
  const tint = hovered ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "transparent",
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Icon name={icon} size={14} color={tint} />
      <Text style={{ fontSize: ui(14), color: tint }}>{label}</Text>
    </Pressable>
  );
}
