import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Image, Platform, Pressable, Text, View } from "react-native";
import { type AppCard, faviconUrl } from "../../shared/apps";
import type { Bot } from "../../shared/bot";
import { Avatar } from "../Avatar";
import { confirmDialog, nativeTokens, useHover } from "../native";
import { CardNote, RowText, Switch } from "../panel/rows";
import { ui } from "../typography";
import { tooltip } from "../ui/Tooltip";

type Colors = PluginTheme["colors"];

export const PAGE_STYLE = {
  padding: 16,
  paddingTop: 24,
  paddingBottom: 32,
  width: "100%",
  maxWidth: 720,
  alignSelf: "center",
} as const;

export function PageTitle({ colors, title }: { colors: Colors; title: string }) {
  return (
    <Text
      accessibilityRole="header"
      numberOfLines={2}
      style={{
        marginLeft: 4,
        marginBottom: 24,
        fontSize: ui(26),
        fontWeight: "500",
        color: colors.foreground,
      }}
    >
      {title}
    </Text>
  );
}

export function BackBar({
  colors,
  title,
  backLabel,
  onBack,
}: {
  colors: Colors;
  title: string;
  backLabel: string;
  onBack(): void;
}) {
  const { hovered, hoverProps } = useHover();
  return (
    <View
      style={{
        height: 56,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface0,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        {...tooltip(backLabel, "bottom")}
        hitSlop={8}
        onPress={onBack}
        {...hoverProps}
        style={({ pressed }) => ({
          padding: 12,
          borderRadius: 8,
          backgroundColor: hovered || pressed ? nativeTokens(colors).interactionHighlight : "transparent",
        })}
      >
        <Icon name="ArrowLeft" size={20} color={hovered ? colors.foreground : colors.foregroundMuted} />
      </Pressable>
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: ui(14), color: colors.foreground }}>
        {title}
      </Text>
    </View>
  );
}

export function BotsCard({
  colors,
  bots,
  uses,
  noun,
  onToggle,
}: {
  colors: Colors;
  bots: Bot[];
  uses(bot: Bot): boolean;
  noun: string;
  onToggle(bot: Bot, on: boolean): void;
}) {
  return (
    <SettingsSection title="Bots" info={`Switched-on bots get this ${noun} in every new chat.`}>
      <SettingsCard>
        {bots.length === 0 ? <CardNote colors={colors} text="No bots yet" /> : null}
        {bots.map((bot) => (
          <View
            key={bot.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingVertical: 12,
              paddingHorizontal: 16,
              minHeight: 56,
            }}
          >
            <Avatar avatar={bot.avatar} size={24} />
            <RowText
              colors={colors}
              label={bot.name || "Untitled bot"}
              hint={bot.archived ? "Archived" : bot.title || null}
            />
            <Switch
              colors={colors}
              label={`Use in ${bot.name}`}
              value={uses(bot)}
              onValueChange={(next) => onToggle(bot, next)}
            />
          </View>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

export function DangerZone({
  label,
  hint,
  actionLabel,
  confirmTitle,
  confirmMessage,
  onConfirm,
}: {
  label: string;
  hint: string;
  actionLabel: string;
  confirmTitle: string;
  confirmMessage: string;
  onConfirm(): void;
}) {
  return (
    <SettingsSection title="Danger zone">
      <SettingsCard>
        <SettingsAction
          label={label}
          hint={hint}
          actionLabel={actionLabel}
          onPress={() =>
            void confirmDialog({
              title: confirmTitle,
              message: confirmMessage,
              confirmLabel: actionLabel,
              destructive: true,
            }).then((confirmed) => confirmed && onConfirm())
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * The light tile keeps dark marks readable on dark themes. Composio's logos are
 * SVGs, which React Native only draws on the web, so phones use the PNG favicon.
 */
export function AppLogo({
  colors,
  app,
  size = 20,
}: {
  colors: Colors;
  app: Pick<AppCard, "name" | "logo" | "domain">;
  size?: number;
}) {
  const sources = [
    Platform.OS === "web" ? app.logo : null,
    app.domain ? faviconUrl(app.domain) : null,
  ].filter((uri): uri is string => !!uri);
  const [failed, setFailed] = useState(0);
  const uri = sources[failed];
  const radius = Math.round(size / 4);
  if (!uri) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: nativeTokens(colors).surface3,
        }}
      >
        <Text
          style={{ fontSize: ui(Math.round(size * 0.55)), fontWeight: "500", color: colors.foregroundMuted }}
        >
          {app.name.slice(0, 1).toUpperCase()}
        </Text>
      </View>
    );
  }
  const inner = Math.round(size * 0.75);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#ffffff",
      }}
    >
      <Image
        key={uri}
        accessibilityIgnoresInvertColors
        source={{ uri }}
        resizeMode="contain"
        onError={() => setFailed((count) => count + 1)}
        style={{ width: inner, height: inner }}
      />
    </View>
  );
}
