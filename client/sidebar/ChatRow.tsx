import type { PluginTheme } from "@getpaseo/plugin";
import { memo, useRef, useState } from "react";
import { type LayoutRectangle, Pressable, Text, View } from "react-native";
import type { Bot } from "../../shared/bot";
import { displayTitle } from "../../shared/chat";
import { BUCKET_LABELS, type ChatBucket, chatBucket } from "../../shared/sidebar";
import { Avatar } from "../Avatar";
import { actionsLabel } from "../a11y";
import type { NativeTokens } from "../native";
import type { PaseoAgent } from "../paseo";
import { ui } from "../typography";
import { contextMenuProps, measureAnchor } from "../ui/Menu";
import { KebabButton } from "./controls";
import { ChatStatusSlot, StatusBadge } from "./status";
import { noSelect } from "./styles";
import type { MenuSource } from "./types";

type Colors = PluginTheme["colors"];

interface ChatRowProps {
  colors: Colors;
  tokens: NativeTokens;
  chat: PaseoAgent;
  bot: Bot;
  selected: boolean;
  touch: boolean;
  /** Pinned rows sit outside their bot, so they lead with its avatar and name it underneath. */
  hoisted?: boolean;
  onPress(): void;
  onMenu(anchor: LayoutRectangle, source: MenuSource): void;
}

export const ChatRow = memo(function ChatRow({
  colors,
  tokens,
  chat,
  bot,
  selected,
  touch,
  hoisted,
  onPress,
  onMenu,
}: ChatRowProps) {
  const [hovered, setHovered] = useState(false);
  const bucket = chatBucket(chat);
  const title = displayTitle(chat.title);
  const showKebab = hovered || touch;
  const background = selected ? tokens.surfaceSidebarSelected : hovered ? colors.surface1 : "transparent";
  // As in BotRow, the ⋮ is the press target's sibling, so a kebab press can't also select the chat.
  return (
    <View
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={[
        {
          position: "relative",
          minHeight: 36,
          marginBottom: 2,
          paddingVertical: 8,
          paddingLeft: 8,
          paddingRight: 12,
          borderRadius: 8,
          justifyContent: "center",
          backgroundColor: background,
        },
        noSelect,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${BUCKET_LABELS[bucket]}`}
        accessibilityState={{ selected }}
        onPress={onPress}
        {...contextMenuProps((anchor) => onMenu(anchor, "context"))}
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
      <View
        pointerEvents="none"
        style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, width: "100%" }}
      >
        {hoisted ? (
          <HoistedChatAvatar
            colors={colors}
            tokens={tokens}
            bot={bot}
            bucket={bucket}
            selected={selected}
            hovered={hovered}
          />
        ) : (
          <ChatStatusSlot colors={colors} tokens={tokens} bucket={bucket} />
        )}
        <ChatRowTitle
          colors={colors}
          bot={bot}
          title={title}
          hoisted={hoisted}
          hovered={hovered}
          touch={touch}
        />
      </View>
      {showKebab ? (
        <ChatRowKebab
          colors={colors}
          tokens={tokens}
          touch={touch}
          selected={selected}
          hovered={hovered}
          title={title}
          onMenu={onMenu}
        />
      ) : null}
    </View>
  );
});

type ChatRowState = { hovered: boolean };

function HoistedChatAvatar({
  colors,
  tokens,
  bot,
  bucket,
  selected,
  hovered,
}: Pick<ChatRowProps, "colors" | "tokens" | "bot" | "selected"> & ChatRowState & { bucket: ChatBucket }) {
  const backdrop = selected
    ? tokens.surfaceSidebarSelected
    : hovered
      ? colors.surface1
      : tokens.surfaceSidebar;
  return (
    <View style={{ width: 16, height: 20, flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
      <View style={{ position: "relative", width: 16, height: 16 }}>
        <Avatar avatar={bot.avatar} size={16} />
        {bucket !== "done" ? (
          <StatusBadge colors={colors} tokens={tokens} bucket={bucket} backdrop={backdrop} />
        ) : null}
      </View>
    </View>
  );
}

function ChatRowTitle({
  colors,
  bot,
  title,
  hoisted,
  hovered,
  touch,
}: Pick<ChatRowProps, "colors" | "bot" | "hoisted" | "touch"> & ChatRowState & { title: string }) {
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: ui(14),
            fontWeight: "400",
            lineHeight: 20,
            color: colors.foreground,
            opacity: hovered ? 1 : 0.76,
          }}
        >
          {title}
        </Text>
        {/* On touch the kebab stays, so its space is reserved; on desktop it overlays the title's tail. */}
        {touch ? <View style={{ width: 18, height: 20 }} /> : null}
      </View>
      {hoisted ? (
        <Text numberOfLines={1} style={{ fontSize: ui(12), lineHeight: 16, color: colors.foregroundMuted }}>
          {bot.name}
        </Text>
      ) : null}
    </View>
  );
}

function ChatRowKebab({
  colors,
  tokens,
  touch,
  selected,
  hovered,
  title,
  onMenu,
}: Pick<ChatRowProps, "colors" | "tokens" | "touch" | "selected" | "onMenu"> &
  ChatRowState & { title: string }) {
  const kebabRef = useRef<View>(null);
  return (
    <View style={{ position: "absolute", top: 8, right: 12, flexDirection: "row" }}>
      {/* A short scrim in the row's colour hides the title's tail under the kebab, as native does. */}
      {touch ? null : (
        <View
          pointerEvents="none"
          style={{ width: 16, backgroundColor: hovered ? colors.surface1 : "transparent" }}
        />
      )}
      <View style={{ backgroundColor: selected ? tokens.surfaceSidebarSelected : colors.surface1 }}>
        <KebabButton
          colors={colors}
          buttonRef={kebabRef}
          label={actionsLabel(title)}
          onPress={() => void measureAnchor(kebabRef).then((anchor) => anchor && onMenu(anchor, "kebab"))}
        />
      </View>
    </View>
  );
}
