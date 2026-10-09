import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ChatBucket } from "../../shared/sidebar";
import { Avatar } from "../Avatar";
import { useHover } from "../native";
import { ui } from "../typography";
import { contextMenuProps, measureAnchor } from "../ui/Menu";
import { tooltip } from "../ui/Tooltip";
import { KebabButton } from "./controls";
import { StatusBadge } from "./status";
import { noSelect } from "./styles";
import type { GroupProps } from "./types";

/** Paseo hardcodes the project chevron colour. */
const CHEVRON_COLOR = "#9ca3af";

type BotRowProps = GroupProps & { isOpen: boolean; aggregate: ChatBucket | null; hostLabel: string | null };

export function BotRow(props: BotRowProps) {
  const { colors, bot, touch, isOpen, onToggle, onBotMenu } = props;
  const [hovered, setHovered] = useState(false);
  // The row's press target sits behind its content and the + / ⋮ buttons are its siblings,
  // not children: nested pressables let a button press leak into the row on react-native-web.
  return (
    <View
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={[
        {
          position: "relative",
          minHeight: 36,
          paddingVertical: 8,
          paddingHorizontal: 8,
          borderRadius: 8,
          marginBottom: 4,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          backgroundColor: hovered ? colors.surface1 : "transparent",
        },
        noSelect,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={bot.name}
        accessibilityState={{ expanded: isOpen }}
        onPress={() => onToggle(bot.id)}
        {...contextMenuProps((anchor) => onBotMenu(bot, anchor, "context"))}
        style={({ pressed }) => ({
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: 8,
          backgroundColor: pressed ? colors.surface2 : "transparent",
        })}
      />
      <BotRowContent {...props} hovered={hovered} />
      <BotRowActions {...props} visible={hovered || touch} />
    </View>
  );
}

function BotRowContent(props: BotRowProps & { hovered: boolean }) {
  const { colors, bot, lead, hostLabel } = props;
  return (
    <View
      pointerEvents="none"
      style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}
    >
      <BotLeadingVisual {...props} />
      <Text
        numberOfLines={1}
        style={{
          minWidth: 0,
          flexShrink: 1,
          fontSize: ui(14),
          color: colors.foregroundMuted,
          opacity: bot.archived ? 0.6 : 1,
        }}
      >
        {bot.name}
        {hostLabel ? ` · ${hostLabel} offline` : ""}
      </Text>
      {lead ? <Icon name="Crown" size={12} color={colors.foregroundMuted} /> : null}
    </View>
  );
}

function BotLeadingVisual({
  colors,
  tokens,
  bot,
  isOpen,
  aggregate,
  hovered,
}: BotRowProps & { hovered: boolean }) {
  const backdrop = hovered ? colors.surface1 : tokens.surfaceSidebar;
  return (
    <View style={{ width: 16, height: 20, flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
      {hovered ? (
        <Icon name={isOpen ? "ChevronDown" : "ChevronRight"} size={14} color={CHEVRON_COLOR} />
      ) : (
        <View style={{ position: "relative", width: 16, height: 16 }}>
          <Avatar avatar={bot.avatar} size={16} />
          {aggregate ? (
            <StatusBadge colors={colors} tokens={tokens} bucket={aggregate} backdrop={backdrop} />
          ) : null}
        </View>
      )}
    </View>
  );
}

function BotRowActions({ colors, bot, visible, onSelect, onBotMenu }: BotRowProps & { visible: boolean }) {
  const kebabRef = useRef<View>(null);
  const plus = useHover();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0, marginRight: -6 }}>
      <View
        style={{
          width: 24,
          height: 24,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          opacity: visible ? 1 : 0,
        }}
        pointerEvents={visible ? "auto" : "none"}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`New chat with ${bot.name}`}
          {...tooltip("New chat", "bottom")}
          hitSlop={8}
          onPress={() => onSelect({ botId: bot.id, chatId: null })}
          {...plus.hoverProps}
          style={({ pressed: down }) => ({
            width: 24,
            height: 24,
            borderRadius: 6,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: plus.hovered || down ? colors.surface1 : "transparent",
          })}
        >
          {({ pressed: down }) => (
            <Icon
              name="Plus"
              size={15}
              color={plus.hovered || down ? colors.foreground : colors.foregroundMuted}
            />
          )}
        </Pressable>
      </View>
      <View style={{ opacity: visible ? 1 : 0 }} pointerEvents={visible ? "auto" : "none"}>
        <KebabButton
          colors={colors}
          buttonRef={kebabRef}
          label="Bot actions"
          box
          onPress={() =>
            void measureAnchor(kebabRef).then((anchor) => anchor && onBotMenu(bot, anchor, "kebab"))
          }
        />
      </View>
    </View>
  );
}
