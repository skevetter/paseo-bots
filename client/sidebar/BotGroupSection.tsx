import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { Animated, Platform, View } from "react-native";
import { aggregateBuckets, chatBucket, orderChats, SIDEBAR_GROUP_LIMIT } from "../../shared/sidebar";
import { useBotChats, useBotHost } from "../data";
import type { PaseoAgent } from "../paseo";
import { BotRow } from "./BotRow";
import { ChatRow } from "./ChatRow";
import { NewChatGhostRow, ShowMoreRow } from "./controls";
import type { GroupProps } from "./types";

type Colors = PluginTheme["colors"];

type GroupBody = "skeleton" | "chats" | "ghost" | null;

function groupBody({
  isOpen,
  loading,
  listed,
  canStart,
}: {
  isOpen: boolean;
  loading: boolean;
  listed: boolean;
  canStart: boolean;
}): GroupBody {
  if (!isOpen) return null;
  if (loading) return "skeleton";
  if (listed) return "chats";
  return canStart ? "ghost" : null;
}

export function BotGroupSection(props: GroupProps) {
  const { colors, tokens, bot, selection, ui: listUi, localHost, pinnedIds, onSelect } = props;
  const host = useBotHost(bot.hostId, localHost);
  const chats = useBotChats(host, bot.id);
  const [expanded, setExpanded] = useState(false);
  const isOpen = !listUi.collapsed.includes(bot.id);
  const draftSelected = selection?.botId === bot.id && selection.chatId === null;

  const unpinned = (chats.data ?? []).filter((chat) => !pinnedIds.has(chat.id));
  const ordered = orderChats(unpinned, listUi.chatSort, listUi.chatOrder[bot.id]);
  // Collapsed rows carry their chats' most urgent status; open ones leave it to the rows.
  const aggregate = isOpen ? null : aggregateBuckets(unpinned.map(chatBucket));
  const body = groupBody({
    isOpen,
    loading: !!host.api && chats.isLoading,
    listed: ordered.length > 0 || draftSelected,
    canStart: !!host.api,
  });

  return (
    <View role="group" accessibilityLabel={bot.name} style={{ paddingBottom: body ? 12 : 0 }}>
      <BotRow {...props} isOpen={isOpen} aggregate={aggregate} hostLabel={host.online ? null : host.label} />
      {body === "skeleton" ? <SkeletonRows colors={colors} /> : null}
      {body === "chats" ? (
        <BotChatList
          {...props}
          chats={ordered}
          draftSelected={draftSelected}
          expanded={expanded}
          onToggleExpanded={() => setExpanded(!expanded)}
        />
      ) : null}
      {body === "ghost" ? (
        <NewChatGhostRow
          colors={colors}
          tokens={tokens}
          selected={false}
          onPress={() => onSelect({ botId: bot.id, chatId: null })}
        />
      ) : null}
    </View>
  );
}

type ChatListProps = GroupProps & {
  chats: readonly PaseoAgent[];
  draftSelected: boolean;
  expanded: boolean;
  onToggleExpanded(): void;
};

function BotChatList({
  colors,
  tokens,
  bot,
  selection,
  touch,
  chats,
  draftSelected,
  expanded,
  onToggleExpanded,
  onSelect,
  onChatMenu,
}: ChatListProps) {
  const siblings = chats.map((chat) => chat.id);
  const visible = expanded ? chats : chats.slice(0, SIDEBAR_GROUP_LIMIT);
  const startDraft = () => onSelect({ botId: bot.id, chatId: null });
  return (
    <>
      {draftSelected && chats.length > 0 ? (
        <NewChatGhostRow colors={colors} tokens={tokens} selected onPress={startDraft} />
      ) : null}
      {visible.map((chat) => (
        <ChatRow
          key={chat.id}
          colors={colors}
          tokens={tokens}
          chat={chat}
          bot={bot}
          touch={touch}
          selected={selection?.botId === bot.id && selection.chatId === chat.id}
          onPress={() => onSelect({ botId: bot.id, chatId: chat.id })}
          onMenu={(anchor, source) =>
            onChatMenu({ bot, chat, anchor, source, context: { siblings, pinned: false } })
          }
        />
      ))}
      {chats.length > SIDEBAR_GROUP_LIMIT ? (
        <ShowMoreRow colors={colors} expanded={expanded} onPress={onToggleExpanded} />
      ) : null}
      {chats.length === 0 ? (
        <NewChatGhostRow colors={colors} tokens={tokens} selected onPress={startDraft} />
      ) : null}
    </>
  );
}

function SkeletonRows({ colors }: { colors: Colors }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const native = Platform.OS !== "web";
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: native }),
        Animated.timing(pulse, { toValue: 0, duration: 1000, useNativeDriver: native }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0.8] });
  return (
    <View accessibilityLabel="Loading chats" style={{ gap: 4 }}>
      {[1, 0.7].map((rowOpacity) => (
        <View
          key={rowOpacity}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 8,
            paddingHorizontal: 12,
            marginLeft: 4,
            opacity: rowOpacity,
          }}
        >
          <Animated.View
            style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.surface2, opacity }}
          />
          <Animated.View
            style={{ flex: 1, height: 12, borderRadius: 2, backgroundColor: colors.surface2, opacity }}
          />
        </View>
      ))}
    </View>
  );
}
