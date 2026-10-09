import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Bot, BotListUi } from "../../shared/bot";
import { SIDEBAR_GROUP_LIMIT } from "../../shared/sidebar";
import { useBotChats, useBotHost } from "../data";
import { type NativeTokens, useHover } from "../native";
import { ui } from "../typography";
import { ChatRow } from "./ChatRow";
import { ShowMoreRow } from "./controls";
import { noSelect } from "./styles";
import type { BotSidebarProps } from "./types";

interface PinnedChat {
  chatId: string;
  bot: Bot;
}

type PinnedProps = BotSidebarProps & {
  pins: readonly PinnedChat[];
  tokens: NativeTokens;
};

export function resolvePins(
  pinned: BotListUi["pinnedChats"],
  botById: ReadonlyMap<string, Bot>,
): PinnedChat[] {
  return pinned.flatMap((pin) => {
    const bot = botById.get(pin.botId);
    return bot ? [{ chatId: pin.chatId, bot }] : [];
  });
}

export function PinnedSection(props: PinnedProps) {
  const { colors, pins, ui: listUi, touch, onTogglePinnedSection } = props;
  const collapsed = listUi.pinnedCollapsed;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? pins : pins.slice(0, SIDEBAR_GROUP_LIMIT);
  const { hovered, hoverProps } = useHover();
  return (
    <View style={{ marginBottom: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Pinned"
        accessibilityState={{ expanded: !collapsed }}
        onPress={onTogglePinnedSection}
        {...hoverProps}
        style={[
          {
            minHeight: 36,
            flexDirection: "row",
            alignItems: "center",
            alignSelf: "flex-start",
            gap: 4,
            paddingHorizontal: 8,
            paddingVertical: 4,
          },
          noSelect,
        ]}
      >
        <Text style={{ fontSize: ui(12), color: colors.foregroundMuted }}>Pinned</Text>
        {hovered || touch ? (
          <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={12} color={colors.foregroundMuted} />
        ) : null}
      </Pressable>
      {collapsed ? null : (
        <>
          {visible.map((pin) => (
            <PinnedChatRow key={pin.chatId} {...props} bot={pin.bot} chatId={pin.chatId} />
          ))}
          {pins.length > SIDEBAR_GROUP_LIMIT ? (
            <ShowMoreRow colors={colors} expanded={expanded} onPress={() => setExpanded(!expanded)} />
          ) : null}
        </>
      )}
    </View>
  );
}

function PinnedChatRow({
  colors,
  tokens,
  bot,
  chatId,
  selection,
  localHost,
  touch,
  onSelect,
  onChatMenu,
}: PinnedProps & PinnedChat) {
  const host = useBotHost(bot.hostId, localHost);
  const chats = useBotChats(host, bot.id);
  const chat = chats.data?.find((entry) => entry.id === chatId);
  if (!chat) return null;
  return (
    <ChatRow
      colors={colors}
      tokens={tokens}
      chat={chat}
      bot={bot}
      hoisted
      touch={touch}
      selected={selection?.botId === bot.id && selection.chatId === chat.id}
      onPress={() => onSelect({ botId: bot.id, chatId: chat.id })}
      onMenu={(anchor, source) =>
        onChatMenu({ bot, chat, anchor, source, context: { siblings: [], pinned: true } })
      }
    />
  );
}
