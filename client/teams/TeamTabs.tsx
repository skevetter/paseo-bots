import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRef } from "react";
import { type LayoutRectangle, Pressable, Text, View } from "react-native";
import type { BotGroup } from "../../shared/bot";
import type { TeamTab } from "../../shared/groups";
import { TeamLogo } from "../Avatar";
import { nativeTokens, useHover } from "../native";
import { ui } from "../typography";
import { contextMenuProps, measureAnchor, useMenu } from "../ui/Menu";
import { tooltip } from "../ui/Tooltip";

type Colors = PluginTheme["colors"];

interface TeamTabsProps {
  colors: Colors;
  tabs: readonly TeamTab[];
  openTab: TeamTab;
  onTab(tabId: string): void;
  onTeamMenu(group: BotGroup, anchor: LayoutRectangle): void;
  onNewTeam(): void;
}

function tabLabel(tab: TeamTab): string {
  return tab.group ? tab.group.name || "Untitled team" : "Other bots";
}

function TabIcon({ colors, tab, highlighted }: { colors: Colors; tab: TeamTab; highlighted: boolean }) {
  return tab.group ? (
    <TeamLogo group={tab.group} size={16} dark={nativeTokens(colors).dark} />
  ) : (
    <Icon name="Bot" size={14} color={highlighted ? colors.foreground : colors.foregroundMuted} />
  );
}

export function TeamTabsRow({ colors, tabs, openTab, onTab, onTeamMenu, onNewTeam }: TeamTabsProps) {
  const add = useHover();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        height: 36,
        flexDirection: "row",
        alignItems: "center",
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface0,
      }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 1 }}
        contentContainerStyle={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 4 }}
      >
        {tabs.map((tab) => {
          const group = tab.group;
          return (
            <TabChip
              key={tab.id}
              colors={colors}
              tab={tab}
              active={tab.id === openTab.id}
              onPress={() => onTab(tab.id)}
              onMenu={group ? (anchor) => onTeamMenu(group, anchor) : undefined}
            />
          );
        })}
      </ScrollView>
      <View style={{ paddingHorizontal: 4 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New team"
          {...tooltip("New team", "bottom")}
          onPress={onNewTeam}
          {...add.hoverProps}
          style={({ pressed }) => ({
            width: 28,
            height: 28,
            borderRadius: 6,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor:
              add.hovered || pressed ? nativeTokens(colors).interactionHighlight : "transparent",
          })}
        >
          <Icon name="Plus" size={14} color={nativeTokens(colors).foregroundExtraMuted} />
        </Pressable>
      </View>
    </View>
  );
}

function TabChip({
  colors,
  tab,
  active,
  onPress,
  onMenu,
}: {
  colors: Colors;
  tab: TeamTab;
  active: boolean;
  onPress(): void;
  onMenu?: (anchor: LayoutRectangle) => void;
}) {
  const { hovered, hoverProps } = useHover();
  const label = tabLabel(tab);
  const highlighted = active || hovered;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      {...tooltip(label, "bottom", { delay: 400 })}
      onPress={onPress}
      {...(onMenu ? contextMenuProps(onMenu) : {})}
      {...hoverProps}
      style={[
        {
          height: 28,
          minWidth: 96,
          maxWidth: 160,
          marginHorizontal: 2,
          paddingHorizontal: 8,
          borderRadius: 6,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          backgroundColor: active ? colors.surface2 : hovered ? colors.surface1 : "transparent",
        },
        { userSelect: "none" } as object,
      ]}
    >
      <View style={{ width: 16, height: 16, flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
        <TabIcon colors={colors} tab={tab} highlighted={highlighted} />
      </View>
      <Text
        numberOfLines={1}
        style={{
          flexShrink: 1,
          minWidth: 0,
          fontSize: ui(14),
          color: highlighted ? colors.foreground : colors.foregroundMuted,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function TeamTabSwitcher({ colors, tabs, openTab, onTab, onNewTeam }: TeamTabsProps) {
  const menu = useMenu();
  const ref = useRef<View>(null);
  const open = () =>
    void measureAnchor(ref).then((anchor) =>
      menu.open({
        anchor: anchor ?? { x: 0, y: 0, width: 0, height: 0 },
        title: "Teams",
        entries: [
          ...tabs.map((tab) => ({
            label: tabLabel(tab),
            leading: <TabIcon colors={colors} tab={tab} highlighted />,
            selected: tab.id === openTab.id,
            onSelect: () => onTab(tab.id),
          })),
          { kind: "separator" as const },
          { label: "New team", icon: "Plus", onSelect: onNewTeam },
        ],
      }),
    );
  return (
    <View
      style={{ backgroundColor: colors.surface0, borderBottomWidth: 1, borderBottomColor: colors.border }}
    >
      <Pressable
        ref={ref}
        accessibilityRole="button"
        accessibilityLabel={`Teams, ${tabLabel(openTab)} open`}
        onPress={open}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 20,
          paddingVertical: 8,
          backgroundColor: pressed ? colors.surface1 : "transparent",
        })}
      >
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View style={{ flexShrink: 0 }}>
            <TabIcon colors={colors} tab={openTab} highlighted />
          </View>
          <Text
            numberOfLines={1}
            style={{ flex: 1, minWidth: 0, fontSize: ui(14), color: colors.foreground }}
          >
            {tabLabel(openTab)}
          </Text>
        </View>
        <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}
