import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { type LayoutRectangle, Pressable, Text, View } from "react-native";
import type { toWire } from "../shared/attachments";
import type { Bot } from "../shared/bot";
import { displayTitle } from "../shared/chat";
import { Avatar } from "./Avatar";
import { Composer } from "./chat/Composer";
import { ChatStream } from "./chat/Stream";
import type { BotHost } from "./data";
import { nativeTokens, useHover } from "./native";
import { ui } from "./typography";
import { measureAnchor } from "./ui/Menu";
import { tooltip } from "./ui/Tooltip";
import type { ChatState } from "./useChat";
import { listenForFind } from "./web";

type Colors = PluginTheme["colors"];

export interface ChatPaneProps {
  colors: Colors;
  bot: Bot;
  host: BotHost;
  chat: ChatState;
  chatId: string | null;
  panelOpen: boolean;
  layout: { compact: boolean; platform: "ios" | "android" | "web" };
  keyboardOpen: boolean;
  /** Bumps when Paseo's font sizes change, so list rows re-render. */
  typeVersion: number;
  onBack?(): void;
  onBotMenu(anchor: LayoutRectangle | null): void;
  onTogglePanel(): void;
  onStart(message: OutgoingMessage): Promise<void>;
  onOpenChat(chatId: string): void;
}

export interface OutgoingMessage {
  text: string;
  messageId: string;
  images: { data: string; mimeType: string }[];
  attachments: ReturnType<typeof toWire>["attachments"];
}

export function ChatPane({
  colors,
  bot,
  host,
  chat,
  chatId,
  panelOpen,
  layout,
  keyboardOpen,
  typeVersion,
  onBack,
  onBotMenu,
  onTogglePanel,
  onStart,
  onOpenChat,
}: ChatPaneProps) {
  const running = chat.agent?.status === "running" || chat.agent?.status === "initializing";
  const empty = isChatEmpty(chat);
  const title = chatId ? displayTitle(chat.agent?.title) : "New chat";
  const canFind = chatId !== null && !empty;
  const [findOpen, setFindOpen] = useState(false);
  const [findChatId, setFindChatId] = useState(chatId);
  if (findChatId !== chatId) {
    setFindChatId(chatId);
    setFindOpen(false);
  }
  useEffect(() => (canFind ? listenForFind(() => setFindOpen(true)) : undefined), [canFind]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <Header
        colors={colors}
        title={title}
        subtitle={bot.name}
        hostBadge={host.isLocal ? null : host.label}
        compact={layout.compact}
        panelOpen={panelOpen}
        onBack={onBack}
        onMenu={onBotMenu}
        onTogglePanel={onTogglePanel}
        onFind={canFind ? () => setFindOpen((open) => !open) : undefined}
      />
      {chatId === null || empty ? (
        <BotIntro colors={colors} bot={bot} />
      ) : (
        <ChatStream
          key={chatId}
          colors={colors}
          chat={chat}
          api={host.api}
          agentId={chatId}
          compact={layout.compact}
          platform={layout.platform}
          typeVersion={typeVersion}
          onOpenChat={onOpenChat}
          voice={bot.voice}
          findOpen={findOpen}
          onCloseFind={() => setFindOpen(false)}
          {...(host.isLocal ? { botId: bot.id } : {})}
        />
      )}
      <Composer
        colors={colors}
        bot={bot}
        host={host}
        agentId={chatId}
        agent={chat.agent}
        running={running}
        layout={layout}
        keyboardOpen={keyboardOpen}
        onStart={onStart}
      />
    </View>
  );
}

function isChatEmpty(chat: ChatState): boolean {
  return (
    chat.entries.length === 0 &&
    !chat.loading &&
    !chat.error &&
    (chat.agent?.pendingPermissions.length ?? 0) === 0
  );
}

function BotIntro({ colors, bot }: { colors: Colors; bot: Bot }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
      <Avatar avatar={bot.avatar} size={56} />
      <Text style={{ color: colors.foreground, fontSize: ui(18), fontWeight: "500" }}>{bot.name}</Text>
      {bot.description ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: ui(14), textAlign: "center", maxWidth: 420 }}>
          {bot.description}
        </Text>
      ) : null}
    </View>
  );
}

interface HeaderProps {
  colors: Colors;
  title: string;
  subtitle: string;
  /** Set when the bot runs on another host. */
  hostBadge: string | null;
  compact: boolean;
  panelOpen: boolean;
  onBack?(): void;
  onMenu(anchor: LayoutRectangle | null): void;
  onTogglePanel(): void;
  /** Absent while there's nothing to find. */
  onFind?: () => void;
}

function Header({
  colors,
  title,
  subtitle,
  hostBadge,
  compact,
  panelOpen,
  onBack,
  onMenu,
  onTogglePanel,
  onFind,
}: HeaderProps) {
  const menuButton = useRef<View>(null);
  const openMenu = () => void measureAnchor(menuButton).then(onMenu);
  return (
    <View
      style={{
        height: compact ? 56 : 36,
        flexDirection: "row",
        alignItems: "center",
        gap: compact ? 4 : 8,
        paddingHorizontal: compact ? 4 : 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface0,
      }}
    >
      {onBack ? <BackButton colors={colors} compact={compact} onBack={onBack} /> : null}
      <HeaderTitle
        colors={colors}
        title={title}
        subtitle={subtitle}
        hostBadge={hostBadge}
        compact={compact}
      />
      {compact ? null : (
        <View ref={menuButton} collapsable={false}>
          <HeaderButton
            colors={colors}
            compact={false}
            icon="Ellipsis"
            label="Bot actions"
            onPress={openMenu}
          />
        </View>
      )}
      <View style={{ flex: 1 }} />
      {compact ? (
        <View ref={menuButton} collapsable={false}>
          <HeaderButton colors={colors} compact icon="Ellipsis" label="Bot actions" onPress={openMenu} />
        </View>
      ) : null}
      {onFind ? (
        <HeaderButton colors={colors} compact={compact} icon="Search" label="Find in chat" onPress={onFind} />
      ) : null}
      <PanelToggle colors={colors} compact={compact} panelOpen={panelOpen} onToggle={onTogglePanel} />
    </View>
  );
}

function PanelToggle({
  colors,
  compact,
  panelOpen,
  onToggle,
}: {
  colors: Colors;
  compact: boolean;
  panelOpen: boolean;
  onToggle(): void;
}) {
  // On desktop the open panel owns its close button, so the toggle hides (workspace-explorer-toggle.tsx).
  if (!compact && panelOpen) return null;
  return (
    <HeaderButton
      colors={colors}
      compact={compact}
      icon="PanelRight"
      label={panelOpen ? "Hide bot settings" : "Show bot settings"}
      expanded={panelOpen}
      onPress={onToggle}
    />
  );
}

function BackButton({ colors, compact, onBack }: { colors: Colors; compact: boolean; onBack(): void }) {
  const tokens = nativeTokens(colors);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back to bots"
      onPress={onBack}
      style={({ pressed }) => ({
        padding: compact ? 12 : 8,
        borderRadius: 8,
        backgroundColor: pressed ? tokens.interactionHighlight : "transparent",
      })}
    >
      <Icon name="ArrowLeft" size={20} color={colors.foregroundMuted} />
    </Pressable>
  );
}

function HeaderTitle({
  colors,
  title,
  subtitle,
  hostBadge,
  compact,
}: Pick<HeaderProps, "colors" | "title" | "subtitle" | "hostBadge" | "compact">) {
  const tokens = nativeTokens(colors);
  if (compact) {
    return (
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: ui(14), fontWeight: "400", color: colors.foreground }}>
          {title}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: ui(12), color: colors.foregroundMuted }}>
          {subtitle}
          {hostBadge ? (
            <Text style={{ fontSize: ui(12), color: tokens.foregroundExtraMuted }}> · </Text>
          ) : null}
          {hostBadge}
        </Text>
      </View>
    );
  }
  return (
    <>
      <Text
        numberOfLines={1}
        style={{ flexShrink: 1, fontSize: ui(14), fontWeight: "300", color: colors.foreground }}
      >
        {title}
      </Text>
      {subtitle !== title ? (
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: ui(14), color: colors.foregroundMuted }}>
          {subtitle}
          {hostBadge ? ` · ${hostBadge}` : ""}
        </Text>
      ) : null}
    </>
  );
}

function HeaderButton({
  colors,
  compact,
  icon,
  label,
  expanded,
  onPress,
}: {
  colors: Colors;
  compact: boolean;
  icon: string;
  label: string;
  expanded?: boolean;
  onPress(): void;
}) {
  const tokens = nativeTokens(colors);
  const { hovered, hoverProps } = useHover();
  const size = compact ? 32 : 26;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...tooltip(label, "bottom")}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hovered || pressed ? tokens.interactionHighlight : "transparent",
      })}
    >
      <Icon name={icon} size={16} color={compact ? colors.foregroundMuted : tokens.foregroundExtraMuted} />
    </Pressable>
  );
}
