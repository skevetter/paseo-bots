import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRef } from "react";
import { type LayoutRectangle, Pressable, Text, View } from "react-native";
import { nativeTokens, useHover } from "./native";
import { Splash } from "./Splash";
import { BotGroupSection } from "./sidebar/BotGroupSection";
import { SidebarEmptyState } from "./sidebar/EmptyState";
import { Footer } from "./sidebar/Footer";
import { PinnedSection, resolvePins } from "./sidebar/PinnedSection";
import { noSelect } from "./sidebar/styles";
import type { BotSidebarProps } from "./sidebar/types";
import { ui } from "./typography";
import { measureAnchor } from "./ui/Menu";
import { tooltip } from "./ui/Tooltip";

type Colors = PluginTheme["colors"];

export function BotSidebar(props: BotSidebarProps) {
  const { colors, bots, openTab, ui: listUi, hiddenArchivedCount, bottomInset, onNewBot, onTeamMap } = props;
  const tokens = nativeTokens(colors);
  const shown = openTab?.bots ?? bots;
  const pinnedIds = new Set(listUi.pinnedChats.map((pin) => pin.chatId));
  const pins = resolvePins(listUi.pinnedChats, new Map(shown.map((bot) => [bot.id, bot])));
  const leadId = openTab?.group?.leadId ?? null;
  if (props.splash && bots.length === 0 && hiddenArchivedCount === 0 && pins.length === 0 && !openTab) {
    return (
      <View style={{ flex: 1, paddingBottom: bottomInset, backgroundColor: tokens.surfaceSidebar }}>
        <Splash colors={colors} background={tokens.surfaceSidebar} />
        <Footer colors={colors} onNewBot={onNewBot} onTeamMap={onTeamMap} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, paddingBottom: bottomInset, backgroundColor: tokens.surfaceSidebar }}>
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 8, paddingTop: 2, paddingBottom: 16 }}
      >
        {pins.length > 0 ? <PinnedSection {...props} pins={pins} tokens={tokens} /> : null}
        {shown.length > 0 || hiddenArchivedCount > 0 ? (
          <SectionHeader colors={colors} onDisplayMenu={props.onDisplayMenu} />
        ) : null}
        {shown.map((bot) => (
          <BotGroupSection
            key={bot.id}
            {...props}
            tokens={tokens}
            bot={bot}
            lead={bot.id === leadId}
            pinnedIds={pinnedIds}
          />
        ))}
        <SidebarEmptyState {...props} shownCount={shown.length} />
      </ScrollView>
      <Footer colors={colors} onNewBot={onNewBot} onTeamMap={onTeamMap} />
    </View>
  );
}

function SectionHeader({
  colors,
  onDisplayMenu,
}: {
  colors: Colors;
  onDisplayMenu(anchor: LayoutRectangle): void;
}) {
  const ref = useRef<View>(null);
  const { hovered, hoverProps } = useHover();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        paddingLeft: 8,
        paddingRight: 4,
        paddingTop: 4,
        paddingBottom: 4,
      }}
    >
      <Text style={[{ fontSize: ui(12), color: colors.foregroundMuted }, noSelect]}>Bots</Text>
      <Pressable
        ref={ref}
        accessibilityRole="button"
        accessibilityLabel="Display preferences"
        {...tooltip("Display preferences", "bottom")}
        onPress={() => void measureAnchor(ref).then((anchor) => anchor && onDisplayMenu(anchor))}
        {...hoverProps}
        style={{
          width: 28,
          height: 28,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          backgroundColor: hovered ? colors.surface1 : "transparent",
        }}
      >
        <Icon name="Settings2" size={14} color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}
