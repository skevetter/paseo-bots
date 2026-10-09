import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { nativeTokens, withAlpha } from "../native";
import { ui } from "../typography";

// Paseo primitives the plugin SDK doesn't export, rebuilt to match their source.

type Colors = PluginTheme["colors"];

const ALERT_ICONS = { default: null, warning: "AlertTriangle", error: "CircleX" } as const;

type AlertVariant = keyof typeof ALERT_ICONS;

function alertAccent(colors: Colors, variant: AlertVariant): string | null {
  const accents: Record<AlertVariant, string | null> = {
    default: null,
    warning: colors.statusWarning,
    error: colors.statusDanger,
  };
  return accents[variant];
}

function descriptionLines(description: string | string[] | undefined): string[] {
  if (description === undefined) return [];
  return Array.isArray(description) ? description : [description];
}

function withOccurrenceKeys(lines: string[]): { key: string; line: string }[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const occurrence = seen.get(line) ?? 0;
    seen.set(line, occurrence + 1);
    return { key: `${line}#${occurrence}`, line };
  });
}

function AlertHeading({
  colors,
  accent,
  icon,
  title,
  fallback,
}: {
  colors: Colors;
  accent: string | null;
  icon: string | null;
  title?: string;
  fallback: ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      {icon ? (
        <View style={{ width: 14, alignItems: "center" }}>
          <Icon name={icon} size={14} color={accent ?? colors.foreground} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {title ? (
          <Text style={{ fontSize: ui(14), fontWeight: "500", color: accent ?? colors.foreground }}>
            {title}
          </Text>
        ) : (
          fallback
        )}
      </View>
    </View>
  );
}

export function Alert({
  colors,
  variant = "default",
  title,
  description,
}: {
  colors: Colors;
  variant?: AlertVariant;
  title?: string;
  description?: string | string[];
}) {
  const accent = alertAccent(colors, variant);
  const icon = ALERT_ICONS[variant];
  const body = withOccurrenceKeys(descriptionLines(description)).map(({ key, line }) => (
    <Text key={key} style={{ fontSize: ui(14), color: colors.foregroundMuted }}>
      {line}
    </Text>
  ));
  const rest = title ? body : body.slice(1);
  return (
    <View
      accessibilityRole="alert"
      style={{
        borderWidth: 1,
        borderColor: accent ? withAlpha(accent, 0.5) : colors.border,
        backgroundColor: "transparent",
        borderRadius: 16,
        paddingVertical: 12,
        paddingHorizontal: 16,
        gap: 2,
      }}
    >
      <AlertHeading colors={colors} accent={accent} icon={icon} title={title} fallback={body[0]} />
      {rest.length ? <View style={{ marginLeft: icon ? 26 : 0 }}>{rest}</View> : null}
    </View>
  );
}

export type BadgeVariant = "success" | "warning" | "error" | "muted";

function badgeStatus(colors: Colors, variant: BadgeVariant): string | null {
  const statuses: Record<BadgeVariant, string | null> = {
    success: colors.statusSuccess,
    warning: colors.statusWarning,
    error: colors.statusDanger,
    muted: null,
  };
  return statuses[variant];
}

export function StatusBadge({
  colors,
  label,
  variant = "muted",
}: {
  colors: Colors;
  label: string;
  variant?: BadgeVariant;
}) {
  const tokens = nativeTokens(colors);
  const status = badgeStatus(colors, variant);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: status ? "transparent" : colors.border,
        backgroundColor: status ? withAlpha(status, tokens.dark ? 0.16 : 0.12) : tokens.surface3,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <Text style={{ fontSize: ui(12), color: status ?? colors.foregroundMuted }}>{label}</Text>
    </View>
  );
}
