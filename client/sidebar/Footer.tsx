import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { useHover } from "../native";
import { openLibrary } from "../navigation";
import { ui } from "../typography";
import { tooltip } from "../ui/Tooltip";
import { noSelect } from "./styles";

type Colors = PluginTheme["colors"];

export function Footer({
  colors,
  onNewBot,
  onTeamMap,
}: {
  colors: Colors;
  onNewBot(): void;
  onTeamMap(): void;
}) {
  const { hovered, hoverProps } = useHover();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 12,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New bot"
        onPress={onNewBot}
        {...hoverProps}
        style={({ pressed }) => [
          {
            minWidth: 0,
            minHeight: 32,
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 6,
            paddingHorizontal: 8,
            borderRadius: 8,
            backgroundColor: pressed ? colors.surface2 : hovered ? colors.surface1 : "transparent",
          },
          noSelect,
        ]}
      >
        <Icon name="Plus" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
        <Text
          numberOfLines={1}
          style={{
            minWidth: 0,
            flexShrink: 1,
            fontSize: ui(14),
            color: hovered ? colors.foreground : colors.foregroundMuted,
          }}
        >
          New bot
        </Text>
      </Pressable>
      <FooterIconButton colors={colors} icon="Network" label="Team map" onPress={onTeamMap} />
      <FooterIconButton colors={colors} icon="Blocks" label="Skills & Tools" onPress={() => openLibrary()} />
    </View>
  );
}

function FooterIconButton({
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...tooltip(label)}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => [
        {
          width: 32,
          height: 32,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed ? colors.surface2 : hovered ? colors.surface1 : "transparent",
        },
        noSelect,
      ]}
    >
      <Icon name={icon} size={16} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}
