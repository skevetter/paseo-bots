import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRef } from "react";
import { type LayoutRectangle, Pressable, Text, View } from "react-native";
import type { Bot } from "../shared/bot";
import { matchesName, splitByPin } from "../shared/sidebar";
import { type NativeTokens, nativeTokens, useHover } from "./native";
import { SearchField } from "./panel/fields";
import { Splash } from "./Splash";
import { BotGroupSection } from "./sidebar/BotGroupSection";
import { SidebarEmptyState } from "./sidebar/EmptyState";
import { Footer } from "./sidebar/Footer";
import { type PinnedChat, PinnedSection, resolvePins } from "./sidebar/PinnedSection";
import { noSelect } from "./sidebar/styles";
import type { BotSidebarProps } from "./sidebar/types";
import { ui } from "./typography";
import { measureAnchor } from "./ui/Menu";
import { tooltip } from "./ui/Tooltip";

type Colors = PluginTheme["colors"];

export function BotSidebar(props: BotSidebarProps) {
  const {
    colors,
    bots,
    openTab,
    hiddenArchivedCount,
    bottomInset,
    onNewBot,
    onTeamMap,
    onFleet,
    onAutomations,
    query,
    onQueryChange,
  } = props;
  const tokens = nativeTokens(colors);
  const shown = openTab?.bots ?? bots;
  const pins = resolvePins(props.ui.pinnedChats, new Map(shown.map((bot) => [bot.id, bot])));
  if (props.splash && bots.length === 0 && hiddenArchivedCount === 0 && pins.length === 0 && !openTab) {
    return (
      <View style={{ flex: 1, paddingBottom: bottomInset, backgroundColor: tokens.surfaceSidebar }}>
        <Splash colors={colors} background={tokens.surfaceSidebar} />
        <Footer
          colors={colors}
          onNewBot={onNewBot}
          onTeamMap={onTeamMap}
          onFleet={onFleet}
          onAutomations={onAutomations}
        />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, paddingBottom: bottomInset, backgroundColor: tokens.surfaceSidebar }}>
      <View style={{ paddingHorizontal: 8, paddingTop: 8 }}>
        <SearchField colors={colors} value={query} onChangeText={onQueryChange} placeholder="Search bots" />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 8, paddingTop: 2, paddingBottom: 16 }}
      >
        <SidebarGroups {...props} tokens={tokens} shown={shown} pins={pins} />
        <SidebarEmptyState {...props} shownCount={shown.length} />
      </ScrollView>
      <Footer
        colors={colors}
        onNewBot={onNewBot}
        onTeamMap={onTeamMap}
        onFleet={onFleet}
        onAutomations={onAutomations}
      />
    </View>
  );
}

function SidebarGroups(
  props: BotSidebarProps & { tokens: NativeTokens; shown: readonly Bot[]; pins: readonly PinnedChat[] },
) {
  const { colors, query, shown, pins, hiddenArchivedCount, openTab, tokens } = props;
  const pinnedIds = new Set(props.ui.pinnedChats.map((pin) => pin.chatId));
  const leadId = openTab?.group?.leadId ?? null;
  const groups = splitByPin(shown.filter((bot) => matchesName(bot.name, query)));
  const matchingPins = pins.filter((pin) => matchesName(pin.bot.name, query));
  const hasPinned = groups.pinned.length + matchingPins.length > 0;
  const noMatches =
    query.trim() !== "" && groups.pinned.length + groups.unpinned.length === 0 && matchingPins.length === 0;
  const renderBot = (bot: Bot) => (
    <BotGroupSection
      key={bot.id}
      {...props}
      tokens={tokens}
      bot={bot}
      lead={bot.id === leadId}
      pinnedIds={pinnedIds}
    />
  );
  return (
    <>
      {hasPinned ? (
        <PinnedSection {...props} pins={matchingPins} tokens={tokens}>
          {groups.pinned.map(renderBot)}
        </PinnedSection>
      ) : null}
      {hasPinned && groups.unpinned.length > 0 ? <Divider colors={colors} /> : null}
      {shown.length > 0 || hiddenArchivedCount > 0 ? (
        <SectionHeader
          colors={colors}
          label={groups.unpinned.length > 0 ? "Bots" : null}
          onDisplayMenu={props.onDisplayMenu}
        />
      ) : null}
      {groups.unpinned.map(renderBot)}
      {noMatches ? <NoMatches colors={colors} query={query} /> : null}
    </>
  );
}

function NoMatches({ colors, query }: { colors: Colors; query: string }) {
  return (
    <Text
      style={{ paddingHorizontal: 8, paddingVertical: 12, fontSize: ui(12), color: colors.foregroundMuted }}
    >
      {`No bots match "${query.trim()}"`}
    </Text>
  );
}

function SectionHeader({
  colors,
  label,
  onDisplayMenu,
}: {
  colors: Colors;
  label: string | null;
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
      <Text style={[{ fontSize: ui(12), color: colors.foregroundMuted }, noSelect]}>{label}</Text>
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

function Divider({ colors }: { colors: Colors }) {
  return (
    <View style={{ height: 1, marginHorizontal: 8, marginVertical: 6, backgroundColor: colors.border }} />
  );
}
