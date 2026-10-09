import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { RefObject } from "react";
import { Pressable, Text, View } from "react-native";
import { type NativeTokens, useHover } from "../native";
import { ui } from "../typography";
import { tooltip } from "../ui/Tooltip";
import { noSelect } from "./styles";

type Colors = PluginTheme["colors"];

/** The one row indented 16, so it reads as belonging to its bot. */
export function NewChatGhostRow({
  colors,
  tokens,
  selected,
  onPress,
}: {
  colors: Colors;
  tokens: NativeTokens;
  selected: boolean;
  onPress(): void;
}) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New chat"
      accessibilityState={{ selected }}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => [
        {
          minHeight: 36,
          marginBottom: 2,
          paddingVertical: 8,
          paddingLeft: 16,
          paddingRight: 12,
          borderRadius: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: pressed
            ? colors.surface2
            : selected
              ? tokens.surfaceSidebarSelected
              : hovered
                ? colors.surface1
                : "transparent",
        },
        noSelect,
      ]}
    >
      {({ pressed }) => (
        <>
          <View
            style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          >
            <Icon
              name="Plus"
              size={14}
              color={hovered || pressed || selected ? colors.foreground : colors.foregroundMuted}
            />
          </View>
          <Text
            numberOfLines={1}
            style={{
              minWidth: 0,
              flexShrink: 1,
              fontSize: ui(14),
              color: hovered || pressed || selected ? colors.foreground : colors.foregroundMuted,
            }}
          >
            New chat
          </Text>
        </>
      )}
    </Pressable>
  );
}

export function ShowMoreRow({
  colors,
  expanded,
  onPress,
}: {
  colors: Colors;
  expanded: boolean;
  onPress(): void;
}) {
  const { hovered, hoverProps } = useHover();
  const label = expanded ? "Show less" : "Show more";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded }}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => [
        {
          minHeight: 36,
          marginBottom: 2,
          paddingVertical: 8,
          paddingLeft: 8,
          paddingRight: 12,
          borderRadius: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: pressed ? colors.surface2 : hovered ? colors.surface1 : "transparent",
        },
        noSelect,
      ]}
    >
      {({ pressed }) => (
        <>
          <View
            style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          >
            <Icon
              name={expanded ? "ChevronUp" : "ChevronDown"}
              size={14}
              color={hovered || pressed ? colors.foreground : colors.foregroundMuted}
            />
          </View>
          <Text
            numberOfLines={1}
            style={{
              minWidth: 0,
              flexShrink: 1,
              fontSize: ui(14),
              color: hovered || pressed ? colors.foreground : colors.foregroundMuted,
            }}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** Without `box` (chat rows) the trigger is pulled onto the rail. */
export function KebabButton({
  colors,
  buttonRef,
  label,
  box,
  onPress,
}: {
  colors: Colors;
  buttonRef: RefObject<View | null>;
  label: string;
  box?: boolean;
  onPress(): void;
}) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      ref={buttonRef}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...tooltip(label, "bottom")}
      hitSlop={8}
      onPress={onPress}
      {...hoverProps}
      style={
        box
          ? {
              width: 24,
              height: 24,
              borderRadius: 6,
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              backgroundColor: hovered ? colors.surface2 : "transparent",
            }
          : {
              padding: 2,
              borderRadius: 4,
              marginLeft: 2,
              marginRight: -7,
              backgroundColor: hovered ? colors.surface2 : "transparent",
            }
      }
    >
      <Icon name="MoreVertical" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}
